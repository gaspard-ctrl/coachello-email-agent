// ============================================================
// POST/GET /api/manual-poll — Polling Gmail déclenché manuellement
// Fonction HTTP (pas de schedule) pour le bouton "Lancer le polling"
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse } from './_db.js';
import { getGmailClient, extractBody, extractAttachments, getHeader, buildRawEmail, markAsRead } from './_gmail.js';
import { classifyAndDraftEmail } from './_claude.js';

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const gmail = getGmailClient();
  const gmailAddress = (process.env.GMAIL_ADDRESS ?? '').toLowerCase();
  // Exclure nos propres envois : -from:me ET -from:adresse explicite
  // Pas de limite de date : on veut traiter tout ce que l'utilisateur voit dans l'inbox.
  const excludeSelf = gmailAddress ? `in:inbox is:unread -from:me -from:${gmailAddress}` : 'in:inbox is:unread -from:me';

  const url = new URL(req.url);

  // ── Mode compteur : nombre de threads non lus dans INBOX ──
  // On lit directement le label INBOX qui expose threadsUnread —
  // c'est exactement la valeur affichée par Gmail dans sa sidebar.
  if (url.searchParams.get('count') === 'true') {
    try {
      const labelRes = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
      return jsonResponse({ count: labelRes.data.threadsUnread ?? 0 });
    } catch (err) {
      return jsonResponse({ count: 0 });
    }
  }

  // ── Mode brouillons : retourne le nombre de brouillons Gmail ──
  if (url.searchParams.get('drafts') === 'true') {
    try {
      const draftsRes = await gmail.users.drafts.list({ userId: 'me', maxResults: 50 });
      return jsonResponse({ drafts: draftsRes.data.drafts?.length ?? 0 });
    } catch {
      return jsonResponse({ drafts: 0 });
    }
  }

  console.log('[manual-poll] Démarrage du polling Gmail —', new Date().toISOString());

  const db = getDb();

  try {
    // ── 1. Charger le guide, les exemples et les règles depuis la BDD ──
    const [guideRows, exampleRows, ruleRows] = await Promise.all([
      db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []),
      db`SELECT email_body, ideal_response, classification FROM examples ORDER BY created_at DESC LIMIT 20`.catch(() => []),
      db`SELECT rule_type, value, classification FROM classification_rules`.catch(() => []),
    ]);

    const guide    = (guideRows[0] as any)?.content ?? '';
    const examples = exampleRows as any[];
    const rules    = ruleRows    as any[];

    // ── 2. Récupérer les IDs des emails déjà traités ──
    const processedRows = await db`SELECT gmail_id, thread_id, status FROM emails WHERE created_at > NOW() - INTERVAL '7 days' AND status != 'dismissed'`;
    const processedIds  = new Set((processedRows as any[]).map((r: any) => r.gmail_id));
    const pendingGmailIds = new Set((processedRows as any[]).filter((r: any) => r.status === 'pending').map((r: any) => r.gmail_id));
    // Tous les threads déjà touchés par une analyse (pending OU sent OU draft_saved)
    // → on ne re-traite pas les nouveaux messages d'un thread déjà connu.
    // Si l'utilisateur veut re-analyser avec un nouveau message, il clique
    // "Faire rédiger par Claude" sur le thread directement.
    const knownThreadIds = new Set((processedRows as any[]).map((r: any) => r.thread_id).filter(Boolean));

    // ── 3. Lister les emails non lus dans Gmail ──
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: excludeSelf,
      maxResults: 20,
    });

    const messages = listRes.data.messages ?? [];
    console.log(`[manual-poll] ${messages.length} email(s) non lu(s) trouvé(s)`);

    // ── Fix 1 : Auto-sync — rejeter les emails lus manuellement dans Gmail ──
    const unreadGmailIds = new Set(messages.map(m => m.id).filter(Boolean) as string[]);
    const pendingRows = await db`SELECT id, gmail_id FROM emails WHERE status = 'pending' AND created_at > NOW() - INTERVAL '7 days'`.catch(() => []);
    const toAutoReject = (pendingRows as any[]).filter(r => r.gmail_id && !unreadGmailIds.has(r.gmail_id));
    if (toAutoReject.length > 0) {
      const ids = toAutoReject.map((r: any) => r.id);
      await db`DELETE FROM emails WHERE id = ANY(${ids})`.catch(() => {});
      console.log(`[manual-poll] ${toAutoReject.length} email(s) lus dans Gmail → supprimés`);
    }

    // ── 3b. MAJ body_html + attachments pour les emails pending existants (sans rappeler Claude) ──
    const pendingToUpdate = messages.filter(m => m.id && pendingGmailIds.has(m.id!));
    if (pendingToUpdate.length > 0) {
      await Promise.all(pendingToUpdate.map(async ({ id: gmailId }) => {
        try {
          const msgRes = await gmail.users.messages.get({ userId: 'me', id: gmailId!, format: 'full' });
          const payload = msgRes.data.payload;
          if (!payload) return;
          const { html: bodyHtml } = extractBody(payload);
          const atts = extractAttachments(payload);
          await db`
            UPDATE emails SET body_html = ${bodyHtml ?? ''}, attachments = ${JSON.stringify(atts)}::jsonb
            WHERE gmail_id = ${gmailId!} AND status = 'pending'
          `.catch(() => {});
          console.log(`[manual-poll] ↻ MAJ attachments/html pour ${gmailId} (${atts.length} pièce(s))`);
        } catch {}
      }));
    }

    // ── 4. Identifier les emails à traiter ──
    // On dédupe par thread_id : un seul message à traiter par thread (le plus récent
    // que Gmail nous renvoie en premier). Évite que "Traitement N/M" affiche les
    // messages individuels au lieu des threads visibles.
    const candidates = messages.filter(m => m.id && !processedIds.has(m.id!) && !(m.threadId && knownThreadIds.has(m.threadId)));
    const seenThreads = new Set<string>();
    const toProcess: typeof candidates = [];
    for (const m of candidates) {
      const tid = m.threadId ?? m.id!;
      if (seenThreads.has(tid)) continue;
      seenThreads.add(tid);
      toProcess.push(m);
    }
    const skipped = messages.length - toProcess.length;
    console.log(`[manual-poll] ${toProcess.length} thread(s) à traiter, ${skipped} déjà traité(s) ou dupliqué(s)`);

    // Aucun email à traiter
    if (toProcess.length === 0) {
      return jsonResponse({ success: true, processed: 0, skipped, total: messages.length, remaining: 0 });
    }

    // ── 5. Traiter uniquement le premier email de la liste ──
    const { id: gmailId, threadId } = toProcess[0];
    const remaining = toProcess.length - 1; // combien restent après celui-ci

    let processResult: 'processed' | 'skipped' | 'error' = 'skipped';

    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: gmailId!,
        format: 'full',
      });

      const payload = msgRes.data.payload;
      if (!payload) {
        return jsonResponse({ success: true, processed: 0, skipped: skipped + 1, total: messages.length, remaining });
      }

      // ── Ignorer les messages envoyés (label SENT) ──
      const labelIds = msgRes.data.labelIds ?? [];
      if (labelIds.includes('SENT')) {
        console.log(`[manual-poll] ⏭ Ignoré (label SENT) : ${gmailId}`);
        await markAsRead(gmailId!);
        return jsonResponse({ success: true, processed: 0, skipped: skipped + 1, total: messages.length, remaining });
      }

      const headers    = payload.headers ?? [];
      const fromRaw    = getHeader(headers, 'From');
      const toRaw      = getHeader(headers, 'To');
      const ccRaw      = getHeader(headers, 'Cc');
      const messageId  = getHeader(headers, 'Message-ID');
      const subject    = getHeader(headers, 'Subject') || '(sans objet)';
      const dateStr    = getHeader(headers, 'Date');
      const receivedAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

      const fromMatch = fromRaw.match(/^(.*?)\s*<(.+?)>$/) ?? [null, fromRaw, fromRaw];
      const fromName  = (fromMatch[1] ?? '').replace(/"/g, '').trim();
      const fromEmail = (fromMatch[2] ?? fromRaw).trim();

      // ── Ignorer nos propres envois ──
      if (gmailAddress && fromEmail.toLowerCase() === gmailAddress) {
        console.log(`[manual-poll] ⏭ Ignoré (notre propre envoi) : ${subject}`);
        await markAsRead(gmailId!);
        return jsonResponse({ success: true, processed: 0, skipped: skipped + 1, total: messages.length, remaining });
      }

      const { text: bodyText, html: bodyHtml } = extractBody(payload);
      const attachments = extractAttachments(payload);

      let effectiveBody = bodyText.trim();
      if (effectiveBody.length < 10 && bodyHtml) {
        effectiveBody = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }

      if (effectiveBody.length < 5 && subject === '(sans objet)') {
        return jsonResponse({ success: true, processed: 0, skipped: skipped + 1, total: messages.length, remaining });
      }

      // ── Appel Claude ──
      const result = await classifyAndDraftEmail({
        guide,
        examples,
        rules,
        fromEmail,
        fromName,
        subject,
        body: effectiveBody.slice(0, 3000),
      });

      // ── Stocker en base (fallback progressif si colonnes manquantes) ──
      try {
        await db`
          INSERT INTO emails (
            gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails,
            subject, body_text, body_html, received_at,
            classification, reasoning, draft_response, status, attachments
          ) VALUES (
            ${gmailId ?? ''}, ${threadId ?? ''}, ${messageId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''}, ${ccRaw ?? ''},
            ${subject}, ${bodyText ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
            ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending',
            ${JSON.stringify(attachments)}::jsonb
          )
          ON CONFLICT (gmail_id) DO UPDATE SET
            body_html   = EXCLUDED.body_html,
            attachments = EXCLUDED.attachments
          WHERE emails.status = 'pending'
        `;
      } catch (insertErr) {
        console.error('[manual-poll] INSERT principal échoué, tentative legacy:', insertErr);
        await db`
          INSERT INTO emails (
            gmail_id, thread_id, from_email, from_name, to_email,
            subject, body_text, body_html, received_at,
            classification, reasoning, draft_response, status
          ) VALUES (
            ${gmailId ?? ''}, ${threadId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''},
            ${subject}, ${bodyText ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
            ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending'
          )
          ON CONFLICT (gmail_id) DO UPDATE SET
            body_html = EXCLUDED.body_html
          WHERE emails.status = 'pending'
        `;
      }

      // ── Alerte si URGENT ──
      if (result.classification === 'URGENT') {
        try {
          const senderEmail  = process.env.GMAIL_ADDRESS ?? 'contact@coachello.io';
          const alertAddress = process.env.URGENT_ALERT_EMAIL ?? 'gaspard@coachello.io';
          const alertRaw     = buildRawEmail({
            to:      alertAddress,
            from:    senderEmail,
            subject: '🚨 MAIL URGENT SUR LA BOITE COACH',
            body: `Un email urgent vient d'arriver sur la boîte Coachello.\n\nDe : ${fromName ? `${fromName} ` : ''}${fromEmail}\nObjet : ${subject}\n\nAnalyse : ${result.reasoning}\n\n→ Traiter sur https://coachello-email-agent.netlify.app`,
          });
          await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: alertRaw },
          });
          console.log(`[manual-poll] Alerte URGENT envoyée à ${alertAddress}`);
        } catch (alertErr) {
          console.error('[manual-poll] Échec envoi alerte URGENT:', alertErr);
        }
      }

      console.log(`[manual-poll] ✓ ${fromEmail} — ${subject} → ${result.classification} (${remaining} restant(s))`);
      processResult = 'processed';

    } catch (err) {
      console.error(`[manual-poll] ✗ Erreur sur email ${gmailId}:`, err);
      processResult = 'error';
    }

    const processed = processResult === 'processed' ? 1 : 0;
    console.log(`[manual-poll] Terminé : ${processed} traité(s), ${remaining} restant(s)`);
    return jsonResponse({ success: true, processed, skipped, total: messages.length, remaining });

  } catch (err) {
    console.error('[manual-poll] Erreur fatale:', err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

export const config: Config = {
  path: '/api/manual-poll',
};

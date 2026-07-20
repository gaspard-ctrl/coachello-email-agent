// ============================================================
// Polling Gmail — déclenché manuellement (plan gratuit)
// Sur Netlify Pro : activer le cron dans netlify.toml
// ============================================================
// import type { Config } from '@netlify/functions'; // à réactiver avec le cron
import { getDb, corsHeaders, jsonResponse } from './_db.js';
import { getGmailClient, extractBody, extractAttachments, getHeader, buildRawEmail, markAsRead, getThreadHistory } from './_gmail.js';
import { classifyAndDraftEmail } from './_claude.js';

export default async function handler(req: Request) {
  const gmail = getGmailClient();
  const gmailAddress = (process.env.GMAIL_ADDRESS ?? '').toLowerCase();
  const excludeSelf = gmailAddress ? `in:inbox is:unread -from:me -from:${gmailAddress}` : 'in:inbox is:unread -from:me';

  // ── Mode compteur : retourne le nombre réel de mails non lus ──
  if (new URL(req.url).searchParams.get('count') === 'true') {
    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: excludeSelf,
        maxResults: 500,
      });
      return jsonResponse({ count: listRes.data.messages?.length ?? 0 });
    } catch (err) {
      return jsonResponse({ count: 0 });
    }
  }

  console.log('[poll-emails] Démarrage du polling Gmail —', new Date().toISOString());

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
    // → on ne re-traite pas les nouveaux messages d'un thread déjà connu, pour
    // éviter de réanalyser (et potentiellement re-classer URGENT) une relance.
    const knownThreadIds = new Set((processedRows as any[]).map((r: any) => r.thread_id).filter(Boolean));

    // ── 3. Lister les emails non lus dans Gmail ──
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: excludeSelf,
      maxResults: 500,
    });

    const messages = listRes.data.messages ?? [];
    console.log(`[poll-emails] ${messages.length} email(s) non lu(s) trouvé(s)`);

    // ── Fix 1 : Auto-sync — rejeter les emails lus manuellement dans Gmail ──
    const unreadGmailIds = new Set(messages.map(m => m.id).filter(Boolean) as string[]);
    const pendingRows = await db`SELECT id, gmail_id FROM emails WHERE status = 'pending' AND created_at > NOW() - INTERVAL '7 days'`.catch(() => []);
    const toAutoReject = (pendingRows as any[]).filter(r => r.gmail_id && !unreadGmailIds.has(r.gmail_id));
    if (toAutoReject.length > 0) {
      const ids = toAutoReject.map((r: any) => r.id);
      await db`DELETE FROM emails WHERE id = ANY(${ids})`.catch(() => {});
      console.log(`[poll-emails] ${toAutoReject.length} email(s) lus dans Gmail → supprimés`);
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
          console.log(`[poll-emails] ↻ MAJ attachments/html pour ${gmailId} (${atts.length} pièce(s))`);
        } catch {}
      }));
    }

    // ── 4. Traiter chaque email nouveau en parallèle ──
    // Exclure les emails déjà traités ET ceux dont le thread est déjà connu
    // (peu importe le statut). Puis dédupe au sein du batch : un seul message
    // par thread, même si Gmail en renvoie plusieurs nouveaux d'un coup.
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
    console.log(`[poll-emails] ${toProcess.length} thread(s) à traiter, ${skipped} déjà traité(s) ou dupliqué(s)`);

    const results = await Promise.all(toProcess.map(async ({ id: gmailId, threadId }) => {
      try {
        // Récupérer le contenu complet
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: gmailId!,
          format: 'full',
        });

        const payload = msgRes.data.payload;
        if (!payload) return 'skipped';

        // ── Ignorer les messages envoyés (label SENT) — protection robuste ──
        const labelIds = msgRes.data.labelIds ?? [];
        if (labelIds.includes('SENT')) {
          console.log(`[poll-emails] ⏭ Ignoré (label SENT) : ${gmailId}`);
          await markAsRead(gmailId!);
          return 'skipped';
        }

        const headers     = payload.headers ?? [];
        const fromRaw     = getHeader(headers, 'From');
        const toRaw       = getHeader(headers, 'To');
        const ccRaw       = getHeader(headers, 'Cc');
        const messageId   = getHeader(headers, 'Message-ID');
        const subject     = getHeader(headers, 'Subject') || '(sans objet)';
        const dateStr     = getHeader(headers, 'Date');
        const receivedAt  = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

        // Parser "Prénom Nom <email@example.com>"
        const fromMatch = fromRaw.match(/^(.*?)\s*<(.+?)>$/) ?? [null, fromRaw, fromRaw];
        const fromName  = (fromMatch[1] ?? '').replace(/"/g, '').trim();
        const fromEmail = (fromMatch[2] ?? fromRaw).trim();

        // ── Ignorer nos propres envois (filet de sécurité si -from:me a échoué) ──
        if (gmailAddress && fromEmail.toLowerCase() === gmailAddress) {
          console.log(`[poll-emails] ⏭ Ignoré (notre propre envoi) : ${subject}`);
          await markAsRead(gmailId!);
          return 'skipped';
        }

        const { text: bodyText, html: bodyHtml } = extractBody(payload);
        const attachments = extractAttachments(payload);

        // Si pas de texte brut, extraire le texte depuis l'HTML (emails HTML-only)
        let effectiveBody = bodyText.trim();
        if (effectiveBody.length < 10 && bodyHtml) {
          effectiveBody = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        // Ignorer les emails vraiment vides (accusés de réception, tracking pixels, etc.)
        if (effectiveBody.length < 5 && subject === '(sans objet)') return 'skipped';

        // ── Historique du thread (pour éviter de re-classer URGENT une simple relance) ──
        const threadHistory = await getThreadHistory(threadId ?? '', gmailId!, gmailAddress);

        // ── 5. Appel Claude ──
        const result = await classifyAndDraftEmail({
          guide,
          examples,
          rules,
          fromEmail,
          fromName,
          subject,
          body: effectiveBody,
          toEmails: toRaw,
          ccEmails: ccRaw,
          selfAddress: gmailAddress,
          threadHistory,
        });

        // ── 6. Stocker en base (upsert : MAJ body_html + attachments si email pending) ──
        try {
          await db`
            INSERT INTO emails (
              gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails,
              subject, body_text, body_html, received_at,
              classification, reasoning, draft_response, status, attachments
            ) VALUES (
              ${gmailId ?? ''}, ${threadId ?? ''}, ${messageId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''}, ${ccRaw ?? ''},
              ${subject}, ${effectiveBody ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
              ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending',
              ${JSON.stringify(attachments)}::jsonb
            )
            ON CONFLICT (gmail_id) DO UPDATE SET
              body_html   = EXCLUDED.body_html,
              attachments = EXCLUDED.attachments
            WHERE emails.status = 'pending'
          `;
        } catch (insertErr) {
          console.error('[poll-emails] INSERT principal échoué, tentative legacy:', insertErr);
          await db`
            INSERT INTO emails (
              gmail_id, thread_id, from_email, from_name, to_email,
              subject, body_text, body_html, received_at,
              classification, reasoning, draft_response, status
            ) VALUES (
              ${gmailId ?? ''}, ${threadId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''},
              ${subject}, ${effectiveBody ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
              ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending'
            )
            ON CONFLICT (gmail_id) DO UPDATE SET
              body_html = EXCLUDED.body_html
            WHERE emails.status = 'pending'
          `;
        }

        // ── 7. Alerte si URGENT ──
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
            console.log(`[poll-emails] Alerte URGENT envoyée à ${alertAddress}`);
          } catch (alertErr) {
            console.error('[poll-emails] Échec envoi alerte URGENT:', alertErr);
          }
        }

        console.log(`[poll-emails] ✓ ${fromEmail} — ${subject} → ${result.classification}`);
        return 'processed';

      } catch (err) {
        console.error(`[poll-emails] ✗ Erreur sur email ${gmailId}:`, err);
        return 'error';
      }
    }));

    const processed = results.filter(r => r === 'processed').length;

    console.log(`[poll-emails] Terminé : ${processed} traité(s), ${skipped} ignoré(s)`);
    return jsonResponse({ success: true, processed, skipped, total: messages.length });

  } catch (err) {
    console.error('[poll-emails] Erreur fatale:', err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// Plan gratuit : fonction déclenchée manuellement via GET /.netlify/functions/poll-emails
// Pour activer le cron automatique, upgrader vers Netlify Pro et décommenter :
// export const config: Config = { schedule: '*/20 * * * *' };

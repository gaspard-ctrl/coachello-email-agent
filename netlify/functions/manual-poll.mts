// ============================================================
// POST/GET /api/manual-poll — Polling Gmail déclenché manuellement
// Fonction HTTP (pas de schedule) pour le bouton "Lancer le polling"
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse } from './_db.js';
import { getGmailClient, extractBody, extractAttachments, getHeader, buildRawEmail } from './_gmail.js';
import { classifyAndDraftEmail } from './_claude.js';

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const gmail = getGmailClient();

  // ── Mode compteur : retourne le nombre réel de mails non lus ──
  if (new URL(req.url).searchParams.get('count') === 'true') {
    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread -from:me newer_than:3d',
        maxResults: 50,
      });
      return jsonResponse({ count: listRes.data.messages?.length ?? 0 });
    } catch (err) {
      return jsonResponse({ count: 0 });
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
    const processedRows = await db`SELECT gmail_id FROM emails WHERE created_at > NOW() - INTERVAL '7 days' AND status NOT IN ('dismissed', 'rejected')`;
    const processedIds  = new Set((processedRows as any[]).map((r: any) => r.gmail_id));

    // ── 3. Lister les emails non lus dans Gmail ──
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread -from:me newer_than:3d',
      maxResults: 10,
    });

    const messages = listRes.data.messages ?? [];
    console.log(`[manual-poll] ${messages.length} email(s) non lu(s) trouvé(s)`);

    let processed = 0;
    let skipped   = 0;

    // ── 4. Traiter chaque email ──
    for (const { id: gmailId, threadId } of messages) {
      if (!gmailId) continue;

      // Déjà en base ? → skip
      if (processedIds.has(gmailId)) {
        skipped++;
        continue;
      }

      try {
        // Récupérer le contenu complet
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: gmailId,
          format: 'full',
        });

        const payload = msgRes.data.payload;
        if (!payload) continue;

        const headers     = payload.headers ?? [];
        const fromRaw     = getHeader(headers, 'From');
        const toRaw       = getHeader(headers, 'To');
        const subject     = getHeader(headers, 'Subject') || '(sans objet)';
        const dateStr     = getHeader(headers, 'Date');
        const receivedAt  = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

        // Parser "Prénom Nom <email@example.com>"
        const fromMatch = fromRaw.match(/^(.*?)\s*<(.+?)>$/) ?? [null, fromRaw, fromRaw];
        const fromName  = (fromMatch[1] ?? '').replace(/"/g, '').trim();
        const fromEmail = (fromMatch[2] ?? fromRaw).trim();

        const { text: bodyText, html: bodyHtml } = extractBody(payload);
        const attachments = extractAttachments(payload);

        // Si pas de texte brut, extraire le texte depuis l'HTML (emails HTML-only)
        let effectiveBody = bodyText.trim();
        if (effectiveBody.length < 10 && bodyHtml) {
          effectiveBody = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        // Ignorer les emails vraiment vides
        if (effectiveBody.length < 5 && subject === '(sans objet)') {
          skipped++;
          continue;
        }

        // ── 5. Appel Claude ──
        const result = await classifyAndDraftEmail({
          guide,
          examples,
          rules,
          fromEmail,
          fromName,
          subject,
          body: effectiveBody.slice(0, 3000),
        });

        // ── 6. Stocker en base ──
        try {
          await db`
            INSERT INTO emails (
              gmail_id, thread_id, from_email, from_name, to_email,
              subject, body_text, body_html, received_at,
              classification, reasoning, draft_response, status, attachments
            ) VALUES (
              ${gmailId}, ${threadId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw},
              ${subject}, ${bodyText}, ${bodyHtml}, ${receivedAt},
              ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending',
              ${JSON.stringify(attachments)}::jsonb
            )
            ON CONFLICT (gmail_id) DO NOTHING
          `;
        } catch {
          await db`
            INSERT INTO emails (
              gmail_id, thread_id, from_email, from_name, to_email,
              subject, body_text, body_html, received_at,
              classification, reasoning, draft_response, status
            ) VALUES (
              ${gmailId}, ${threadId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw},
              ${subject}, ${bodyText}, ${bodyHtml}, ${receivedAt},
              ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending'
            )
            ON CONFLICT (gmail_id) DO NOTHING
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
            console.log(`[manual-poll] Alerte URGENT envoyée à ${alertAddress}`);
          } catch (alertErr) {
            console.error('[manual-poll] Échec envoi alerte URGENT:', alertErr);
          }
        }

        processed++;
        console.log(`[manual-poll] ✓ ${fromEmail} — ${subject} → ${result.classification}`);
        break; // 1 email traité par appel (anti-timeout)

      } catch (err) {
        console.error(`[manual-poll] ✗ Erreur sur email ${gmailId}:`, err);
      }
    }

    console.log(`[manual-poll] Terminé : ${processed} traité(s), ${skipped} ignoré(s)`);
    return jsonResponse({ success: true, processed, skipped, total: messages.length });

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

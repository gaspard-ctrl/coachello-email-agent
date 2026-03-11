// ============================================================
// Polling Gmail — déclenché manuellement (plan gratuit)
// Sur Netlify Pro : activer le cron dans netlify.toml
// ============================================================
// import type { Config } from '@netlify/functions'; // à réactiver avec le cron
import { getDb, corsHeaders, jsonResponse } from './_db.js';
import { getGmailClient, extractBody, extractAttachments, getHeader, buildRawEmail } from './_gmail.js';
import { classifyAndDraftEmail } from './_claude.js';

export default async function handler(req: Request) {
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
    const processedRows = await db`SELECT gmail_id FROM emails WHERE created_at > NOW() - INTERVAL '7 days' AND status NOT IN ('dismissed', 'rejected')`;
    const processedIds  = new Set((processedRows as any[]).map((r: any) => r.gmail_id));

    // ── 3. Lister les emails non lus dans Gmail ──
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread -from:me newer_than:3d',
      maxResults: 20,
    });

    const messages = listRes.data.messages ?? [];
    console.log(`[poll-emails] ${messages.length} email(s) non lu(s) trouvé(s)`);

    // ── Fix 1 : Auto-sync — rejeter les emails lus manuellement dans Gmail ──
    const unreadGmailIds = new Set(messages.map(m => m.id).filter(Boolean) as string[]);
    const pendingRows = await db`SELECT id, gmail_id FROM emails WHERE status = 'pending' AND created_at > NOW() - INTERVAL '7 days'`.catch(() => []);
    const toAutoReject = (pendingRows as any[]).filter(r => r.gmail_id && !unreadGmailIds.has(r.gmail_id));
    if (toAutoReject.length > 0) {
      const ids = toAutoReject.map((r: any) => r.id);
      await db`UPDATE emails SET status = 'rejected', validated_at = NOW() WHERE id = ANY(${ids})`.catch(() => {});
      console.log(`[poll-emails] ${toAutoReject.length} email(s) lus dans Gmail → rejetés automatiquement`);
    }

    // ── 4. Traiter chaque email nouveau en parallèle ──
    const toProcess = messages.filter(m => m.id && !processedIds.has(m.id!));
    const skipped = messages.length - toProcess.length;
    console.log(`[poll-emails] ${toProcess.length} email(s) à traiter, ${skipped} déjà traité(s)`);

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

        // Ignorer les emails vraiment vides (accusés de réception, tracking pixels, etc.)
        if (effectiveBody.length < 5 && subject === '(sans objet)') return 'skipped';

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

        // ── 6. Stocker en base (avec fallback si colonne attachments absente) ──
        try {
          await db`
            INSERT INTO emails (
              gmail_id, thread_id, from_email, from_name, to_email,
              subject, body_text, body_html, received_at,
              classification, reasoning, draft_response, status, attachments
            ) VALUES (
              ${gmailId ?? ''}, ${threadId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''},
              ${subject}, ${bodyText ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
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
              ${gmailId ?? ''}, ${threadId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''},
              ${subject}, ${bodyText ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
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

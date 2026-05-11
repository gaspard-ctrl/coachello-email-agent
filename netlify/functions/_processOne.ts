// ============================================================
// Helper partagé : traiter UN email Gmail (extraction + Claude + insert DB)
// Utilisé par manual-poll, poll-emails (cron) et analyze-email (à la demande)
// ============================================================
import { getDb } from './_db.js';
import { getGmailClient, extractBody, extractAttachments, getHeader, buildRawEmail, markAsRead, getThreadHistory } from './_gmail.js';
import { classifyAndDraftEmail } from './_claude.js';

export type ProcessResult =
  | { status: 'processed'; emailDbId: string; classification: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

export async function loadClaudeContext() {
  const db = getDb();
  const [guideRows, exampleRows, ruleRows] = await Promise.all([
    db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []),
    db`SELECT email_body, ideal_response, classification FROM examples ORDER BY created_at DESC LIMIT 20`.catch(() => []),
    db`SELECT rule_type, value, classification FROM classification_rules`.catch(() => []),
  ]);
  return {
    guide: (guideRows[0] as any)?.content ?? '',
    examples: exampleRows as any[],
    rules: ruleRows as any[],
  };
}

/**
 * Traite un email Gmail : extraction, classification Claude, insertion DB.
 *
 * @param gmailId  ID Gmail du message
 * @param threadId ID du thread Gmail (optionnel — si non fourni, sera lu depuis Gmail)
 * @param ctx      Contexte Claude (guide/examples/rules). Si absent, sera chargé depuis la DB.
 */
export async function processOneEmail(
  gmailId: string,
  threadId?: string,
  ctx?: Awaited<ReturnType<typeof loadClaudeContext>>,
): Promise<ProcessResult> {
  const db = getDb();
  const gmail = getGmailClient();
  const gmailAddress = (process.env.GMAIL_ADDRESS ?? '').toLowerCase();
  const context = ctx ?? await loadClaudeContext();

  try {
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id: gmailId,
      format: 'full',
    });

    const payload = msgRes.data.payload;
    if (!payload) return { status: 'skipped', reason: 'no payload' };

    const msgThreadId = threadId ?? msgRes.data.threadId ?? '';

    // ── Ignorer les messages envoyés (label SENT) ──
    const labelIds = msgRes.data.labelIds ?? [];
    if (labelIds.includes('SENT')) {
      if (msgThreadId) await markAsRead(msgThreadId);
      return { status: 'skipped', reason: 'label SENT' };
    }

    const headers = payload.headers ?? [];
    const fromRaw = getHeader(headers, 'From');
    const toRaw = getHeader(headers, 'To');
    const ccRaw = getHeader(headers, 'Cc');
    const messageId = getHeader(headers, 'Message-ID');
    const subject = getHeader(headers, 'Subject') || '(sans objet)';
    const dateStr = getHeader(headers, 'Date');
    const receivedAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
    const effectiveThreadId = msgThreadId;

    const fromMatch = fromRaw.match(/^(.*?)\s*<(.+?)>$/) ?? [null, fromRaw, fromRaw];
    const fromName = (fromMatch[1] ?? '').replace(/"/g, '').trim();
    const fromEmail = (fromMatch[2] ?? fromRaw).trim();

    // ── Ignorer nos propres envois ──
    if (gmailAddress && fromEmail.toLowerCase() === gmailAddress) {
      if (effectiveThreadId) await markAsRead(effectiveThreadId);
      return { status: 'skipped', reason: 'own email' };
    }

    const { text: bodyText, html: bodyHtml } = extractBody(payload);
    const attachments = extractAttachments(payload);

    let effectiveBody = bodyText.trim();
    if (effectiveBody.length < 10 && bodyHtml) {
      effectiveBody = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    if (effectiveBody.length < 5 && subject === '(sans objet)') {
      return { status: 'skipped', reason: 'empty body' };
    }

    // ── Historique du thread (pour éviter de re-classer URGENT une simple relance) ──
    const threadHistory = await getThreadHistory(effectiveThreadId, gmailId, gmailAddress);

    // ── Appel Claude ──
    const result = await classifyAndDraftEmail({
      guide: context.guide,
      examples: context.examples,
      rules: context.rules,
      fromEmail,
      fromName,
      subject,
      body: effectiveBody,
      threadHistory,
    });

    // ── Stocker en base (fallback progressif si colonnes manquantes) ──
    let inserted: any[] = [];
    try {
      inserted = await db`
        INSERT INTO emails (
          gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails,
          subject, body_text, body_html, received_at,
          classification, reasoning, draft_response, status, attachments
        ) VALUES (
          ${gmailId}, ${effectiveThreadId}, ${messageId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''}, ${ccRaw ?? ''},
          ${subject}, ${effectiveBody ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
          ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending',
          ${JSON.stringify(attachments)}::jsonb
        )
        ON CONFLICT (gmail_id) DO UPDATE SET
          body_html   = EXCLUDED.body_html,
          attachments = EXCLUDED.attachments,
          classification = EXCLUDED.classification,
          reasoning      = EXCLUDED.reasoning,
          draft_response = EXCLUDED.draft_response
        WHERE emails.status = 'pending'
        RETURNING id
      ` as any[];
    } catch (insertErr) {
      console.error('[processOneEmail] INSERT principal échoué, fallback legacy:', insertErr);
      inserted = await db`
        INSERT INTO emails (
          gmail_id, thread_id, from_email, from_name, to_email,
          subject, body_text, body_html, received_at,
          classification, reasoning, draft_response, status
        ) VALUES (
          ${gmailId}, ${effectiveThreadId}, ${fromEmail}, ${fromName}, ${toRaw ?? ''},
          ${subject}, ${effectiveBody ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
          ${result.classification}, ${result.reasoning}, ${result.draft_response}, 'pending'
        )
        ON CONFLICT (gmail_id) DO UPDATE SET
          body_html = EXCLUDED.body_html
        WHERE emails.status = 'pending'
        RETURNING id
      ` as any[];
    }

    // ── Alerte si URGENT ──
    if (result.classification === 'URGENT') {
      try {
        const senderEmail = process.env.GMAIL_ADDRESS ?? 'contact@coachello.io';
        const alertAddress = process.env.URGENT_ALERT_EMAIL ?? 'gaspard@coachello.io';
        const alertRaw = buildRawEmail({
          to: alertAddress,
          from: senderEmail,
          subject: '🚨 MAIL URGENT SUR LA BOITE COACH',
          body: `Un email urgent vient d'arriver.\n\nDe : ${fromName ? `${fromName} ` : ''}${fromEmail}\nObjet : ${subject}\n\nAnalyse : ${result.reasoning}\n\n→ Traiter sur https://coachello-email-agent.netlify.app`,
        });
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw: alertRaw } });
      } catch (alertErr) {
        console.error('[processOneEmail] Échec envoi alerte URGENT:', alertErr);
      }
    }

    const emailDbId = inserted[0]?.id ?? '';
    return { status: 'processed', emailDbId, classification: result.classification };

  } catch (err) {
    console.error(`[processOneEmail] ✗ Erreur sur ${gmailId}:`, err);
    return { status: 'error', error: String(err) };
  }
}

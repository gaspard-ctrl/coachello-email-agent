// ============================================================
// POST /api/analyze-email — Analyse synchrone d'UN email à la demande
//
// Code inline calqué structurellement sur manual-poll.mts (qui marche),
// pour éliminer toute différence subtile via processOneEmail.
// Reçoit gmail_id + thread_id en payload au lieu de lister les unread.
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient, extractBody, extractAttachments, getHeader, buildRawEmail, markAsRead, markAsUnread, getThreadHistory } from './_gmail.js';
import { classifyAndDraftEmail } from './_claude.js';

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Méthode non autorisée', 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const gmailId = body.gmail_id as string | undefined;
    const threadId = body.thread_id as string | undefined;
    const userContext = typeof body.context === 'string' ? body.context.trim() : '';

    if (!gmailId) {
      return errorResponse('gmail_id requis', 400);
    }

    const gmail = getGmailClient();
    const gmailAddress = (process.env.GMAIL_ADDRESS ?? '').toLowerCase();
    const db = getDb();

    // ── 0. Court-circuit : si déjà en DB, on renvoie la row complète sans Claude ──
    //    (sauf si l'utilisateur a fourni des instructions spécifiques : on relance l'analyse)
    const exists = userContext ? [] : await db`SELECT id FROM emails WHERE gmail_id = ${gmailId} LIMIT 1` as any[];
    if (exists.length > 0) {
      const fullRow = await db`
        SELECT id, gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails, subject,
               LEFT(body_text, 5000) AS body_text,
               body_html,
               LEFT(body_text, 200) AS body_preview,
               received_at, classification, reasoning,
               LEFT(draft_response, 300) AS draft_preview,
               draft_response, status, locked_by, locked_at,
               validated_at, validated_by, created_at,
               COALESCE(attachments, '[]'::jsonb) AS attachments
        FROM emails
        WHERE gmail_id = ${gmailId}
        LIMIT 1
      ` as any[];
      return jsonResponse({ success: true, email: fullRow[0] });
    }

    // ── 1. Charger le guide, les exemples et les règles depuis la BDD ──
    const [guideRows, exampleRows, ruleRows] = await Promise.all([
      db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []),
      db`SELECT email_body, ideal_response, classification FROM examples ORDER BY created_at DESC LIMIT 20`.catch(() => []),
      db`SELECT rule_type, value, classification FROM classification_rules`.catch(() => []),
    ]);

    const guide    = (guideRows[0] as any)?.content ?? '';
    const examples = exampleRows as any[];
    const rules    = ruleRows    as any[];

    // ── 2. Fetch le message Gmail ──
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id: gmailId,
      format: 'full',
    });

    const payload = msgRes.data.payload;
    if (!payload) {
      return jsonResponse({ success: false, skipped: true, reason: 'no payload' }, 200);
    }

    const effectiveThreadId = threadId ?? msgRes.data.threadId ?? '';

    // Capturer l'état "lu / non-lu" avant l'analyse pour le restaurer en non-lu après si besoin
    const labelIds = msgRes.data.labelIds ?? [];
    const wasUnread = labelIds.includes('UNREAD');

    // ── Ignorer les messages envoyés (label SENT) ──
    if (labelIds.includes('SENT')) {
      console.log(`[analyze-email] ⏭ Ignoré (label SENT) : ${gmailId}`);
      if (effectiveThreadId) await markAsRead(effectiveThreadId);
      return jsonResponse({ success: false, skipped: true, reason: 'label SENT' }, 200);
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
      console.log(`[analyze-email] ⏭ Ignoré (notre propre envoi) : ${subject}`);
      if (effectiveThreadId) await markAsRead(effectiveThreadId);
      return jsonResponse({ success: false, skipped: true, reason: 'own email' }, 200);
    }

    const { text: bodyText, html: bodyHtml } = extractBody(payload);
    const attachments = extractAttachments(payload);

    let effectiveBody = bodyText.trim();
    if (effectiveBody.length < 10 && bodyHtml) {
      effectiveBody = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    if (effectiveBody.length < 5 && subject === '(sans objet)') {
      return jsonResponse({ success: false, skipped: true, reason: 'empty body' }, 200);
    }

    // ── Historique du thread (pour éviter URGENT sur une simple relance) ──
    const threadHistory = await getThreadHistory(effectiveThreadId, gmailId, gmailAddress);

    // ── Appel Claude ──
    const result = await classifyAndDraftEmail({
      guide,
      examples,
      rules,
      fromEmail,
      fromName,
      subject,
      body: effectiveBody,
      threadHistory,
      ...(userContext ? { context: userContext } : {}),
    });

    // ── Stocker en base (fallback progressif si colonnes manquantes) ──
    try {
      await db`
        INSERT INTO emails (
          gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails,
          subject, body_text, body_html, received_at,
          classification, reasoning, draft_response, status, attachments
        ) VALUES (
          ${gmailId}, ${effectiveThreadId}, ${messageId ?? ''}, ${fromEmail}, ${fromName}, ${toRaw ?? ''}, ${ccRaw ?? ''},
          ${subject}, ${bodyText ?? ''}, ${bodyHtml ?? ''}, ${receivedAt},
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
      `;
    } catch (insertErr) {
      console.error('[analyze-email] INSERT principal échoué, tentative legacy:', insertErr);
      await db`
        INSERT INTO emails (
          gmail_id, thread_id, from_email, from_name, to_email,
          subject, body_text, body_html, received_at,
          classification, reasoning, draft_response, status
        ) VALUES (
          ${gmailId}, ${effectiveThreadId}, ${fromEmail}, ${fromName}, ${toRaw ?? ''},
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
        console.log(`[analyze-email] Alerte URGENT envoyée à ${alertAddress}`);
      } catch (alertErr) {
        console.error('[analyze-email] Échec envoi alerte URGENT:', alertErr);
      }
    }

    console.log(`[analyze-email] ✓ ${fromEmail} — ${subject} → ${result.classification}`);

    // ── Si l'email était déjà lu, le repasser en non-lu pour qu'il apparaisse
    //    comme actionnable dans l'inbox (puisque l'utilisateur a explicitement
    //    demandé une analyse). ──
    if (!wasUnread && effectiveThreadId) {
      await markAsUnread(effectiveThreadId);
    }

    // ── Recharger la row complète (avec body_html) pour le front ──
    const inserted = await db`
      SELECT id, gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails, subject,
             LEFT(body_text, 5000) AS body_text,
             body_html,
             LEFT(body_text, 200) AS body_preview,
             received_at, classification, reasoning,
             LEFT(draft_response, 300) AS draft_preview,
             draft_response, status, locked_by, locked_at,
             validated_at, validated_by, created_at,
             COALESCE(attachments, '[]'::jsonb) AS attachments
      FROM emails
      WHERE gmail_id = ${gmailId}
      LIMIT 1
    ` as any[];

    if (inserted.length === 0) {
      return errorResponse('Email inséré introuvable', 500);
    }

    return jsonResponse({ success: true, email: inserted[0] });

  } catch (err) {
    console.error('[analyze-email] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/analyze-email',
};

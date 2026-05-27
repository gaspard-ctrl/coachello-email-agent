// ============================================================
// POST /api/emails/:id/:action
// Actions : lock | unlock | validate | reject
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient, buildRawEmail, markAsRead, type OutgoingAttachment } from './_gmail.js';
import { askClarifyingQuestions } from './_claude.js';

// Extraire l'adresse email d'une entrée "Nom <email>" ou "email"
function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).toLowerCase().trim();
}

// Construit les champs To / Cc / In-Reply-To d'une réponse.
// Par défaut on répond au mail ingéré ; si `override` est fourni, on répond
// à un message précis du thread (son expéditeur devient le destinataire).
async function buildReplyParams(opts: {
  gmail: any;
  senderEmail: string;
  email: any;
  override: { from: string; to: string; cc: string; gmail_id: string } | null;
}): Promise<{ to: string; cc?: string; inReplyTo?: string }> {
  const { gmail, senderEmail, email, override } = opts;
  const toAddr = override ? (override.from || email.from_email) : email.from_email;
  const replyGmailId = override ? override.gmail_id : email.gmail_id;

  // Message-ID de l'email cible (pour In-Reply-To / References)
  let inReplyTo: string | undefined = (!override && email.message_id) ? email.message_id : undefined;
  if (!inReplyTo && replyGmailId) {
    try {
      const orig = await gmail.users.messages.get({
        userId: 'me', id: replyGmailId, format: 'metadata', metadataHeaders: ['Message-ID'],
      });
      inReplyTo = orig.data.payload?.headers?.find((h: any) => h.name?.toLowerCase() === 'message-id')?.value || undefined;
    } catch { /* silencieux */ }
  }

  // Reply All : Cc = (To + Cc du message cible) sauf nous-mêmes et sauf le destinataire
  const recipientEmail = extractEmail(toAddr);
  const srcTo = override ? override.to : (email.to_email ?? '');
  const srcCc = override ? override.cc : (email.cc_emails ?? '');
  const keep = (s: string) => !!s && extractEmail(s) !== senderEmail && extractEmail(s) !== recipientEmail;
  const ccTo = (srcTo ?? '').split(',').map((s: string) => s.trim()).filter(keep);
  const ccCc = (srcCc ?? '').split(',').map((s: string) => s.trim()).filter(keep);
  const cc = [...ccTo, ...ccCc].join(', ') || undefined;

  return { to: toAddr, cc, inReplyTo };
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Méthode non autorisée', 405);
  }

  const url    = new URL(req.url);
  const parts  = url.pathname.split('/').filter(Boolean);
  // /api/emails/:id/:action  →  ['api', 'emails', ':id', ':action']
  const emailId = parts[2];
  const action  = parts[3]; // lock | unlock | validate | reject

  if (!emailId || !action) {
    return errorResponse('URL invalide — attendu : /api/emails/:id/:action', 400);
  }

  const db = getDb();

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const {
      user = 'team', final_response, attachments: reqAttachments,
      gmail_id: bodyGmailId, thread_id: bodyThreadId,
      from_email: bodyFromEmail, to_email: bodyToEmail,
      cc_emails: bodyCcEmails, subject: bodySubject,
      // Override "répondre à un message précis du thread" (pas seulement le dernier)
      reply_from: bodyReplyFrom, reply_to: bodyReplyTo,
      reply_cc: bodyReplyCc, reply_gmail_id: bodyReplyGmailId,
    } = body as {
      user?: string; final_response?: string; attachments?: OutgoingAttachment[];
      gmail_id?: string; thread_id?: string;
      from_email?: string; to_email?: string;
      cc_emails?: string; subject?: string;
      reply_from?: string; reply_to?: string;
      reply_cc?: string; reply_gmail_id?: string;
    };

    // Cible de réponse : par défaut le mail ingéré, ou un message précis du thread si fourni.
    const replyOverride = bodyReplyGmailId ? {
      from:     bodyReplyFrom ?? '',
      to:       bodyReplyTo ?? '',
      cc:       bodyReplyCc ?? '',
      gmail_id: bodyReplyGmailId,
    } : null;

    // ── Récupérer l'email ──
    // Cas 1 : email tmp-* (non analysé, pas de row DB) → construire depuis le body
    // Cas 2 : email analysé → row DB
    const isTmp = emailId.startsWith('tmp-');
    let email: any;
    if (isTmp) {
      if (!bodyGmailId) return errorResponse('gmail_id requis pour les emails non analysés', 400);
      email = {
        id: emailId,
        gmail_id:    bodyGmailId,
        thread_id:   bodyThreadId ?? null,
        from_email:  bodyFromEmail ?? '',
        to_email:    bodyToEmail ?? '',
        cc_emails:   bodyCcEmails ?? null,
        subject:     bodySubject ?? '(sans objet)',
        message_id:  null,
        draft_response: null,
        status:      'pending',
      };
    } else {
      const rows = await db`SELECT * FROM emails WHERE id = ${emailId}`;
      if ((rows as any[]).length === 0) return errorResponse('Email introuvable', 404);
      email = (rows as any[])[0];
    }

    // ──────────────────────────────────────────────────
    // ACTION : lock (un membre de l'équipe ouvre l'email)
    // ──────────────────────────────────────────────────
    if (action === 'lock') {
      if (isTmp) return jsonResponse({ success: true, action: 'locked', skipped: true });
      if (email.status === 'locked' && email.locked_by !== user) {
        return jsonResponse({ locked: true, locked_by: email.locked_by }, 409);
      }
      await db`
        UPDATE emails
        SET status = 'locked', locked_by = ${user}, locked_at = NOW()
        WHERE id = ${emailId}
      `;
      return jsonResponse({ success: true, action: 'locked' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : unlock
    // ──────────────────────────────────────────────────
    if (action === 'unlock') {
      if (isTmp) return jsonResponse({ success: true, action: 'unlocked', skipped: true });
      await db`
        UPDATE emails
        SET status = 'pending', locked_by = NULL, locked_at = NULL
        WHERE id = ${emailId}
      `;
      return jsonResponse({ success: true, action: 'unlocked' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : reject
    // ──────────────────────────────────────────────────
    if (action === 'reject') {
      const gmailOk = email.thread_id ? await markAsRead(email.thread_id) : true;

      if (!isTmp) {
        if (gmailOk) {
          await db`DELETE FROM emails WHERE id = ${emailId}`;
        } else {
          await db`UPDATE emails SET status = 'rejected', validated_by = ${user}, validated_at = NOW() WHERE id = ${emailId}`;
        }
      }
      return jsonResponse({ success: true, action: 'rejected' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : report (marquer comme spam dans Gmail)
    // ──────────────────────────────────────────────────
    if (action === 'report') {
      let gmailOk = false;
      if (email.gmail_id) {
        try {
          const gmail = getGmailClient();
          await gmail.users.messages.modify({
            userId: 'me',
            id: email.gmail_id,
            requestBody: {
              addLabelIds: ['SPAM'],
              removeLabelIds: ['INBOX', 'UNREAD'],
            },
          });
          gmailOk = true;
        } catch (err) {
          console.error(`[email-action] Échec report Gmail pour ${email.gmail_id}:`, err);
        }
      } else {
        gmailOk = true;
      }

      if (!isTmp) {
        if (gmailOk) {
          await db`DELETE FROM emails WHERE id = ${emailId}`;
        } else {
          await db`UPDATE emails SET status = 'rejected', validated_by = ${user}, validated_at = NOW() WHERE id = ${emailId}`;
        }
      }
      return jsonResponse({ success: true, action: 'reported' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : validate (envoyer ou créer brouillon Gmail)
    // ──────────────────────────────────────────────────
    if (action === 'validate') {
      const responseText = final_response ?? email.draft_response;
      if (!responseText) return errorResponse('Aucun texte de réponse fourni', 400);

      const gmail       = getGmailClient();
      const senderEmail = (process.env.GMAIL_ADDRESS ?? 'contact@coachello.io').toLowerCase();

      const { to, cc, inReplyTo } = await buildReplyParams({ gmail, senderEmail, email, override: replyOverride });

      const raw = buildRawEmail({
        to,
        from:       senderEmail,
        subject:    email.subject,
        body:       responseText,
        cc,
        threadId:   email.thread_id,
        inReplyTo,
        attachments: reqAttachments,
      });

      // Envoi direct pour toutes les classifications
      const sendRes = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId: email.thread_id },
      });

      // Marquer le thread envoyé comme lu (markAsRead attend un thread_id, pas un message_id)
      const sentThreadId = sendRes.data.threadId ?? email.thread_id;
      if (sentThreadId) {
        await markAsRead(sentThreadId);
      }

      // Marquer l'email original comme lu dans Gmail AVANT de toucher la DB
      const gmailOk = email.thread_id ? await markAsRead(email.thread_id) : false;

      // Si Gmail OK → supprimer de la DB. Sinon garder avec status='sent' pour ne pas réingérer.
      if (!isTmp) {
        if (gmailOk) {
          await db`DELETE FROM emails WHERE id = ${emailId}`;
        } else {
          await db`
            UPDATE emails
            SET status = 'sent', validated_by = ${user}, validated_at = NOW(),
                final_response = ${responseText}
            WHERE id = ${emailId}
          `;
        }
      }

      return jsonResponse({ success: true, action: 'sent' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : draft (brouillon Gmail pour tout type d'email)
    // ──────────────────────────────────────────────────
    if (action === 'draft') {
      const responseText = final_response ?? email.draft_response;
      if (!responseText) return errorResponse('Aucun texte de réponse fourni', 400);

      const gmail       = getGmailClient();
      const senderEmail = (process.env.GMAIL_ADDRESS ?? 'contact@coachello.io').toLowerCase();

      const { to, cc, inReplyTo } = await buildReplyParams({ gmail, senderEmail, email, override: replyOverride });

      const raw = buildRawEmail({
        to,
        from:      senderEmail,
        subject:   email.subject,
        body:      responseText,
        cc,
        threadId:  email.thread_id,
        inReplyTo,
        attachments: reqAttachments,
      });

      await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw, threadId: email.thread_id },
        },
      });

      // Marquer comme lu dans Gmail d'abord (markAsRead attend un thread_id)
      const gmailOk = email.thread_id ? await markAsRead(email.thread_id) : false;

      if (!isTmp) {
        if (gmailOk) {
          await db`DELETE FROM emails WHERE id = ${emailId}`;
        } else {
          await db`
            UPDATE emails
            SET status = 'draft_saved', validated_by = ${user}, validated_at = NOW(),
                final_response = ${responseText}
            WHERE id = ${emailId}
          `;
        }
      }
      return jsonResponse({ success: true, action: 'draft_saved' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : ask (générer des questions de clarification)
    // ──────────────────────────────────────────────────
    if (action === 'ask') {
      const guideRows = await db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []);
      const guide = (guideRows[0] as any)?.content ?? '';
      const questions = await askClarifyingQuestions({
        guide,
        fromEmail: email.from_email,
        fromName:  email.from_name,
        subject:   email.subject,
        body:      email.body_text ?? '',
      });
      return jsonResponse({ success: true, questions });
    }

    return errorResponse(`Action inconnue : ${action}`, 400);

  } catch (err) {
    console.error(`[email-action] Erreur (${action} on ${emailId}):`, err);
    return errorResponse('Erreur serveur', 500);
  }
}

export const config: Config = {
  path: '/api/emails/:id/:action',
};

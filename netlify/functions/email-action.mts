// ============================================================
// POST /api/emails/:id/:action
// Actions : lock | unlock | validate | reject
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient, buildRawEmail } from './_gmail.js';
import { askClarifyingQuestions, redraftWithContext } from './_claude.js';

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
    // ── Récupérer l'email ──
    const rows = await db`SELECT * FROM emails WHERE id = ${emailId}`;
    if ((rows as any[]).length === 0) return errorResponse('Email introuvable', 404);
    const email = (rows as any[])[0];

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const { user = 'team', final_response } = body as { user?: string; final_response?: string };

    // ──────────────────────────────────────────────────
    // ACTION : lock (un membre de l'équipe ouvre l'email)
    // ──────────────────────────────────────────────────
    if (action === 'lock') {
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
      await db`
        UPDATE emails
        SET status = 'rejected', validated_by = ${user}, validated_at = NOW()
        WHERE id = ${emailId}
      `;
      // Marquer comme lu dans Gmail
      if (email.gmail_id) {
        const gmail = getGmailClient();
        await gmail.users.messages.modify({
          userId: 'me',
          id: email.gmail_id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        }).catch(() => {/* silencieux */});
      }
      return jsonResponse({ success: true, action: 'rejected' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : report (marquer comme spam dans Gmail)
    // ──────────────────────────────────────────────────
    if (action === 'report') {
      if (email.gmail_id) {
        const gmail = getGmailClient();
        await gmail.users.messages.modify({
          userId: 'me',
          id: email.gmail_id,
          requestBody: {
            addLabelIds: ['SPAM'],
            removeLabelIds: ['INBOX', 'UNREAD'],
          },
        }).catch(() => {/* silencieux */});
      }
      await db`
        UPDATE emails
        SET status = 'rejected', validated_by = ${user}, validated_at = NOW()
        WHERE id = ${emailId}
      `;
      return jsonResponse({ success: true, action: 'reported' });
    }

    // ──────────────────────────────────────────────────
    // ACTION : validate (envoyer ou créer brouillon Gmail)
    // ──────────────────────────────────────────────────
    if (action === 'validate') {
      const responseText = final_response ?? email.draft_response;
      if (!responseText) return errorResponse('Aucun texte de réponse fourni', 400);

      const gmail       = getGmailClient();
      const senderEmail = process.env.GMAIL_ADDRESS ?? 'contact@coachello.io';

      const raw = buildRawEmail({
        to:       email.from_email,
        from:     senderEmail,
        subject:  email.subject,
        body:     responseText,
        threadId: email.thread_id,
      });

      // URGENT et IMPORTANT → brouillon (validation humaine finale dans Gmail)
      // NORMAL et FAIBLE    → envoi direct
      const sendDirect = ['NORMAL', 'FAIBLE'].includes(email.classification);

      const markAsRead = () => gmail.users.messages.modify({
        userId: 'me',
        id: email.gmail_id,
        requestBody: { removeLabelIds: ['UNREAD'] },
      }).catch(() => {/* silencieux */});

      if (sendDirect) {
        await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw, threadId: email.thread_id },
        });
        await db`
          UPDATE emails
          SET status = 'sent', validated_by = ${user}, validated_at = NOW(),
              final_response = ${responseText}
          WHERE id = ${emailId}
        `;
        await markAsRead();
        return jsonResponse({ success: true, action: 'sent' });

      } else {
        // Brouillon Gmail
        await gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: { raw, threadId: email.thread_id },
          },
        });
        await db`
          UPDATE emails
          SET status = 'draft_saved', validated_by = ${user}, validated_at = NOW(),
              final_response = ${responseText}
          WHERE id = ${emailId}
        `;
        await markAsRead();
        return jsonResponse({ success: true, action: 'draft_saved' });
      }
    }

    // ──────────────────────────────────────────────────
    // ACTION : draft (brouillon Gmail pour tout type d'email)
    // ──────────────────────────────────────────────────
    if (action === 'draft') {
      const responseText = final_response ?? email.draft_response;
      if (!responseText) return errorResponse('Aucun texte de réponse fourni', 400);

      const gmail       = getGmailClient();
      const senderEmail = process.env.GMAIL_ADDRESS ?? 'contact@coachello.io';

      const raw = buildRawEmail({
        to:       email.from_email,
        from:     senderEmail,
        subject:  email.subject,
        body:     responseText,
        threadId: email.thread_id,
      });

      await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw, threadId: email.thread_id },
        },
      });
      await db`
        UPDATE emails
        SET status = 'draft_saved', validated_by = ${user}, validated_at = NOW(),
            final_response = ${responseText}
        WHERE id = ${emailId}
      `;
      await gmail.users.messages.modify({
        userId: 'me',
        id: email.gmail_id,
        requestBody: { removeLabelIds: ['UNREAD'] },
      }).catch(() => {/* silencieux */});
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
        body:      (email.body_text ?? '').slice(0, 3000),
      });
      return jsonResponse({ success: true, questions });
    }

    // ──────────────────────────────────────────────────
    // ACTION : redraft (régénérer brouillon avec contexte)
    // ──────────────────────────────────────────────────
    if (action === 'redraft') {
      const { context } = body as { context?: string };
      if (!context) return errorResponse('context requis', 400);

      const [guideRows, exampleRows] = await Promise.all([
        db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []),
        db`SELECT email_body, ideal_response, classification FROM examples ORDER BY created_at DESC LIMIT 5`.catch(() => []),
      ]);

      const newDraft = await redraftWithContext({
        guide:     (guideRows[0] as any)?.content ?? '',
        examples:  exampleRows as any[],
        fromEmail: email.from_email,
        fromName:  email.from_name,
        subject:   email.subject,
        body:      (email.body_text ?? '').slice(0, 3000),
        context,
      });

      await db`UPDATE emails SET draft_response = ${newDraft} WHERE id = ${emailId}`;
      return jsonResponse({ success: true, draft: newDraft });
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

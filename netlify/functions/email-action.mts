// ============================================================
// POST /api/emails/:id/:action
// Actions : lock | unlock | validate | reject
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient, buildRawEmail } from './_gmail.js';

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

    return errorResponse(`Action inconnue : ${action}`, 400);

  } catch (err) {
    console.error(`[email-action] Erreur (${action} on ${emailId}):`, err);
    return errorResponse('Erreur serveur', 500);
  }
}

export const config: Config = {
  path: '/api/emails/:id/:action',
};

// ============================================================
// POST /api/mark-read — Toggle l'état lu/non-lu d'un thread Gmail
// Body : { thread_id?: string, gmail_id?: string, unread?: boolean }
//   - On raisonne au niveau thread (comme Gmail). thread_id est préféré ;
//     si seul gmail_id est fourni, on récupère le thread_id depuis Gmail.
//   - unread === true   → ajoute le label UNREAD sur tout le thread
//   - sinon (default)   → retire le label UNREAD de tout le thread
// ============================================================
import type { Config } from '@netlify/functions';
import { corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient } from './_gmail.js';

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
    let threadId = body.thread_id as string | undefined;
    const setUnread = !!body.unread;
    if (!threadId && !gmailId) return errorResponse('thread_id ou gmail_id requis', 400);

    const gmail = getGmailClient();

    if (!threadId && gmailId) {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: gmailId,
        format: 'metadata',
        metadataHeaders: [],
      });
      threadId = msgRes.data.threadId ?? undefined;
    }

    if (!threadId) return errorResponse('thread_id introuvable', 400);

    await gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: setUnread
        ? { addLabelIds: ['UNREAD'] }
        : { removeLabelIds: ['UNREAD'] },
    });

    return jsonResponse({ success: true, thread_id: threadId, gmail_id: gmailId, is_unread: setUnread });
  } catch (err) {
    console.error('[mark-read] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/mark-read',
};

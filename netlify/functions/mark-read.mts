// ============================================================
// POST /api/mark-read — Toggle l'état lu/non-lu d'un message Gmail
// Body : { gmail_id: string, unread?: boolean }
//   - unread === true   → ajoute le label UNREAD (marque comme non lu)
//   - sinon (default)   → retire le label UNREAD (marque comme lu)
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
    const setUnread = !!body.unread;
    if (!gmailId) return errorResponse('gmail_id requis', 400);

    const gmail = getGmailClient();
    await gmail.users.messages.modify({
      userId: 'me',
      id: gmailId,
      requestBody: setUnread
        ? { addLabelIds: ['UNREAD'] }
        : { removeLabelIds: ['UNREAD'] },
    });

    return jsonResponse({ success: true, gmail_id: gmailId, is_unread: setUnread });
  } catch (err) {
    console.error('[mark-read] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/mark-read',
};

// ============================================================
// GET /api/gmail-thread?id=THREAD_ID — Récupère tous les messages d'un thread
// Retour : { messages: ThreadMessage[] } (chronologique, ancien → récent)
// ============================================================
import type { Config } from '@netlify/functions';
import { corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient, getHeader, extractBody, extractAttachments } from './_gmail.js';

interface ThreadAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  contentId?: string;
}

interface ThreadMessage {
  gmail_id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  snippet: string;
  body_text: string;
  body_html: string;
  is_me: boolean;
  is_unread: boolean;
  attachments: ThreadAttachment[];
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return errorResponse('Méthode non autorisée', 405);
  }

  try {
    const url = new URL(req.url);
    const threadId = url.searchParams.get('id');
    if (!threadId) return errorResponse('id requis', 400);

    const gmail = getGmailClient();
    const myAddress = (process.env.GMAIL_ADDRESS ?? '').toLowerCase();

    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    const rawMessages = res.data.messages ?? [];

    const messages: ThreadMessage[] = rawMessages.map(m => {
      const headers = m.payload?.headers ?? [];
      const fromRaw = getHeader(headers, 'From');
      const toRaw = getHeader(headers, 'To');
      const ccRaw = getHeader(headers, 'Cc');
      const subject = getHeader(headers, 'Subject');
      const dateStr = getHeader(headers, 'Date');
      const date = dateStr ? new Date(dateStr).toISOString() : '';
      const { text, html } = extractBody(m.payload);
      const atts = extractAttachments(m.payload);
      const labelIds: string[] = m.labelIds ?? [];
      // Détection "moi" : l'adresse env GMAIL_ADDRESS apparaît dans le From
      const fromLower = fromRaw.toLowerCase();
      const is_me = !!myAddress && fromLower.includes(myAddress);
      return {
        gmail_id: m.id ?? '',
        from: fromRaw,
        to: toRaw,
        ...(ccRaw ? { cc: ccRaw } : {}),
        subject,
        date,
        snippet: m.snippet ?? '',
        body_text: text,
        body_html: html,
        is_me,
        is_unread: labelIds.includes('UNREAD'),
        attachments: atts,
      };
    });

    return jsonResponse({ messages });
  } catch (err) {
    console.error('[gmail-thread] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/gmail-thread',
};

// ============================================================
// GET /api/attachment?gmailId=xxx&attachmentId=yyy
// Proxy pour servir les pièces jointes/images inline depuis Gmail
// ============================================================
import type { Config } from '@netlify/functions';
import { getGmailClient } from './_gmail.js';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const gmailId      = url.searchParams.get('gmailId');
  const attachmentId = url.searchParams.get('attachmentId');
  const mimeType     = url.searchParams.get('mimeType') ?? 'image/png';
  const filename     = url.searchParams.get('filename') ?? '';
  const download     = url.searchParams.get('download') === '1';

  if (!gmailId || !attachmentId) {
    return new Response('Missing gmailId or attachmentId', { status: 400, headers: corsHeaders });
  }

  try {
    const gmail = getGmailClient();
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: gmailId,
      id: attachmentId,
    });

    // Gmail renvoie du base64url, convertir en buffer
    const base64 = res.data.data!.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(base64, 'base64');

    const headers: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=86400',  // Cache 24h
    };
    if (filename) {
      // RFC 5987 — supporte accents/caractères non-ASCII
      const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
      const encodedName = encodeURIComponent(filename);
      const disposition = download ? 'attachment' : 'inline';
      headers['Content-Disposition'] = `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
    }

    return new Response(buffer, {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error('[attachment-proxy] Erreur:', err);
    return new Response('Attachment not found', { status: 404, headers: corsHeaders });
  }
}

export const config: Config = {
  path: '/api/attachment',
};

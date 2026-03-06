// ============================================================
// Helper partagé : client Gmail via OAuth 2.0
// ============================================================
import { google } from 'googleapis';

export function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Décoder le corps d'un email (base64url → string)
export function decodeBase64(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// Extraire le corps texte d'un message Gmail (récursif pour multipart)
export function extractBody(payload: any): { text: string; html: string } {
  let text = '';
  let html = '';

  if (!payload) return { text, html };

  // Message simple (non multipart)
  if (payload.body?.data) {
    const decoded = decodeBase64(payload.body.data);
    if (payload.mimeType === 'text/plain') text = decoded;
    if (payload.mimeType === 'text/html')  html = decoded;
    return { text, html };
  }

  // Message multipart : parcourir les parties
  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = extractBody(part);
      if (sub.text) text = sub.text;
      if (sub.html) html = sub.html;
    }
  }

  return { text, html };
}

// Extraire la valeur d'un header Gmail
export function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Extraire les pièces jointes d'un message Gmail
export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export function extractAttachments(payload: any): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];
  function scan(part: any) {
    if (part?.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part?.parts) part.parts.forEach(scan);
  }
  if (payload) scan(payload);
  return attachments;
}

// Construire un email brut RFC 2822 encodé en base64url (pour envoi/brouillon)
export function buildRawEmail(opts: {
  to: string;
  from: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}): string {
  const lines = [
    `To: ${opts.to}`,
    `From: ${opts.from}`,
    `Subject: Re: ${opts.subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
  ];

  if (opts.inReplyTo) {
    lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    lines.push(`References: ${opts.inReplyTo}`);
  }

  lines.push('');
  lines.push(opts.body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

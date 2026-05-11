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

// Marquer un thread entier comme lu dans Gmail (comme Gmail : on raisonne au niveau thread)
export async function markAsRead(threadId: string): Promise<boolean> {
  try {
    const gmail = getGmailClient();
    await gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
    return true;
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code ?? 'unknown';
    const message = err?.response?.data?.error?.message ?? err?.message ?? '';
    console.error(`[gmail] ✗ Échec markAsRead(${threadId}) — HTTP ${status}: ${message}`);
    if (status === 403) {
      console.error('[gmail] ⚠ Le scope OAuth "gmail.modify" est probablement manquant. Scopes actuels insuffisants pour modifier les labels.');
    }
    return false;
  }
}

// Re-marquer un thread comme non lu (utile quand on analyse à la demande un mail déjà lu :
// l'utilisateur veut le voir réapparaître comme actionnable dans l'inbox).
export async function markAsUnread(threadId: string): Promise<boolean> {
  try {
    const gmail = getGmailClient();
    await gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: { addLabelIds: ['UNREAD'] },
    });
    return true;
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code ?? 'unknown';
    const message = err?.response?.data?.error?.message ?? err?.message ?? '';
    console.error(`[gmail] ✗ Échec markAsUnread(${threadId}) — HTTP ${status}: ${message}`);
    return false;
  }
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

// Extraire les images inline (Content-ID) d'un payload Gmail
export interface InlineImage {
  contentId: string;       // ex: "image001@01D..."
  mimeType: string;
  attachmentId: string;
}

export function extractInlineImages(payload: any): InlineImage[] {
  const images: InlineImage[] = [];
  function scan(part: any) {
    if (!part) return;
    const headers = part.headers ?? [];
    const contentId = headers.find((h: any) => h.name.toLowerCase() === 'content-id')?.value;
    const contentDisposition = headers.find((h: any) => h.name.toLowerCase() === 'content-disposition')?.value ?? '';
    const isInline = contentDisposition.toLowerCase().startsWith('inline') || (contentId && part.mimeType?.startsWith('image/'));
    if (isInline && contentId && part.body?.attachmentId) {
      // Strip angle brackets from Content-ID: <image001@xxx> → image001@xxx
      const cid = contentId.replace(/^<|>$/g, '');
      images.push({
        contentId: cid,
        mimeType: part.mimeType ?? 'image/png',
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) part.parts.forEach(scan);
  }
  scan(payload);
  return images;
}

// Remplacer les cid: dans le HTML par des data URIs base64
export async function resolveInlineImages(
  gmail: any,
  messageId: string,
  html: string,
  inlineImages: InlineImage[],
): Promise<string> {
  if (!html || inlineImages.length === 0) return html;

  let resolved = html;
  for (const img of inlineImages) {
    try {
      const attRes = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: img.attachmentId,
      });
      const base64Data = attRes.data.data.replace(/-/g, '+').replace(/_/g, '/');
      const dataUri = `data:${img.mimeType};base64,${base64Data}`;
      // Replace cid:xxx references in src attributes
      resolved = resolved.replace(
        new RegExp(`cid:${img.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'),
        dataUri,
      );
    } catch {
      // Skip unresolvable images
    }
  }
  return resolved;
}

// Extraire la valeur d'un header Gmail
export function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Récupérer l'historique condensé d'un thread Gmail : tous les messages précédant
// `currentGmailId` (exclu), du plus ancien au plus récent. Renvoie [] si le thread
// ne contient qu'un seul message (cas le plus fréquent). Utilisé pour donner le
// contexte conversationnel à Claude lors de la classification.
export interface ThreadHistoryMessage {
  from: string;       // "Prénom Nom <email>"
  date: string;       // header Date brut
  isOwn: boolean;     // true si envoyé depuis notre boîte (label SENT)
  body: string;       // texte brut, déjà nettoyé
}

export async function getThreadHistory(
  threadId: string,
  currentGmailId: string,
  ownAddress?: string,
): Promise<ThreadHistoryMessage[]> {
  if (!threadId) return [];
  try {
    const gmail = getGmailClient();
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    const messages = res.data.messages ?? [];
    if (messages.length <= 1) return [];

    const own = (ownAddress ?? '').toLowerCase();
    const history: ThreadHistoryMessage[] = [];
    for (const msg of messages) {
      if (msg.id === currentGmailId) continue;
      const headers = msg.payload?.headers ?? [];
      const from = getHeader(headers, 'From');
      const date = getHeader(headers, 'Date');
      const fromEmail = (from.match(/<(.+?)>/)?.[1] ?? from).toLowerCase();
      const labelIds = msg.labelIds ?? [];
      const isOwn = labelIds.includes('SENT') || (!!own && fromEmail === own);

      const { text, html } = extractBody(msg.payload);
      let body = text.trim();
      if (body.length < 10 && html) {
        body = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      // Tronquer pour limiter les tokens : on garde l'essentiel (premiers 800 char)
      if (body.length > 800) body = body.slice(0, 800) + '…';

      history.push({ from, date, isOwn, body });
    }
    return history;
  } catch (err) {
    console.error(`[gmail] ✗ getThreadHistory(${threadId}) échoué:`, err);
    return [];
  }
}

// Extraire les pièces jointes d'un message Gmail (inclut images inline avec contentId)
export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  contentId?: string;  // Présent pour les images inline (cid:)
}

export function extractAttachments(payload: any): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];
  function scan(part: any) {
    if (!part) return;
    const headers = part.headers ?? [];
    const contentId = headers.find((h: any) => h.name?.toLowerCase() === 'content-id')?.value;

    if (part.body?.attachmentId) {
      const cid = contentId ? contentId.replace(/^<|>$/g, '') : undefined;
      attachments.push({
        filename: part.filename || cid || 'inline',
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
        ...(cid ? { contentId: cid } : {}),
      });
    }
    if (part.parts) part.parts.forEach(scan);
  }
  scan(payload);
  return attachments;
}

// Encoder un header RFC 2047 si le sujet contient des caractères non-ASCII
function encodeSubject(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// Type pour les pièces jointes sortantes
export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64
}

// Construire un email brut RFC 2822 encodé en base64url (pour envoi/brouillon)
export function buildRawEmail(opts: {
  to: string;
  from: string;
  subject: string;
  body: string;
  cc?: string;
  threadId?: string;
  inReplyTo?: string;
  attachments?: OutgoingAttachment[];
}): string {
  // Ajouter "Re: " seulement pour les réponses (inReplyTo présent) et si pas déjà présent
  const subjectLine = opts.inReplyTo && !/^Re:\s/i.test(opts.subject)
    ? `Re: ${opts.subject}`
    : opts.subject;
  const hasAttachments = opts.attachments && opts.attachments.length > 0;

  const headers = [
    `To: ${opts.to}`,
    `From: ${opts.from}`,
    `Subject: ${encodeSubject(subjectLine)}`,
    'MIME-Version: 1.0',
  ];

  if (opts.cc) {
    headers.push(`Cc: ${opts.cc}`);
  }

  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    headers.push(`References: ${opts.inReplyTo}`);
  }

  if (!hasAttachments) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    const raw = [...headers, '', opts.body].join('\r\n');
    return Buffer.from(raw).toString('base64url');
  }

  // Multipart/mixed avec pièces jointes
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  let email = headers.join('\r\n') + '\r\n\r\n';

  // Partie texte
  email += `--${boundary}\r\n`;
  email += 'Content-Type: text/plain; charset=utf-8\r\n\r\n';
  email += opts.body + '\r\n\r\n';

  // Parties pièces jointes
  for (const att of opts.attachments!) {
    email += `--${boundary}\r\n`;
    email += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
    email += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
    email += 'Content-Transfer-Encoding: base64\r\n\r\n';
    email += att.data + '\r\n\r\n';
  }

  email += `--${boundary}--`;
  return Buffer.from(email).toString('base64url');
}

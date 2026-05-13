// ============================================================
// GET /api/gmail-inbox — Récupérer TOUT l'inbox Gmail (analysé ou non)
// Merge la liste Gmail avec les classifications déjà calculées en DB
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient, getHeader } from './_gmail.js';

interface GmailEmailDTO {
  gmail_id: string;
  thread_id: string;
  folder: 'inbox' | 'sent' | 'drafts';
  from_email: string;
  from_name: string;
  to_email: string;
  to_name: string;
  subject: string;
  snippet: string;
  received_at: string;
  is_unread: boolean;
  is_starred: boolean;
  is_analyzed: boolean;
  classification?: string;
  email_db_id?: string;
  status?: string;
}

function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/"/g, '').trim(), email: m[2].trim() };
  return { name: '', email: raw.trim() };
}

// Le champ `snippet` de l'API Gmail arrive encodé en HTML (&#39;, &amp;, &quot;, etc.).
// On le décode ici pour qu'il s'affiche correctement en texte brut côté front.
function decodeHtmlEntities(s: string): string {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
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
    const folder = (url.searchParams.get('folder') ?? 'inbox') as 'inbox' | 'sent' | 'drafts';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
    const pageToken = url.searchParams.get('pageToken') ?? undefined;
    const search = (url.searchParams.get('search') ?? '').trim();

    const gmail = getGmailClient();
    const db = getDb();

    const folderQ = folder === 'sent' ? 'in:sent' : folder === 'drafts' ? 'in:drafts' : 'in:inbox';
    const q = search ? `${folderQ} ${search}` : folderQ;

    // ── 1. Liste des IDs Gmail ──
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: limit,
      ...(pageToken ? { pageToken } : {}),
    });

    const messageRefs = listRes.data.messages ?? [];
    if (messageRefs.length === 0) {
      return jsonResponse({ emails: [], nextPageToken: null });
    }

    // ── 2. Charger les métadonnées en parallèle (format=metadata pour la rapidité) ──
    const messages = await Promise.all(
      messageRefs.map(async ({ id }) => {
        try {
          const res = await gmail.users.messages.get({
            userId: 'me',
            id: id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          });
          return res.data;
        } catch {
          return null;
        }
      }),
    );

    const validMessages = messages.filter(Boolean) as any[];
    const gmailIds = validMessages.map(m => m.id as string).filter(Boolean);

    // ── 3. Charger les rows DB correspondantes en une seule requête ──
    const dbRows = gmailIds.length > 0
      ? await db`
          SELECT id, gmail_id, classification, status
          FROM emails
          WHERE gmail_id = ANY(${gmailIds})
        ` as any[]
      : [];

    const dbByGmailId = new Map(dbRows.map(r => [r.gmail_id as string, r]));

    // ── 4. Merger ──
    const emails: GmailEmailDTO[] = validMessages.map(msg => {
      const headers = msg.payload?.headers ?? [];
      const fromRaw = getHeader(headers, 'From');
      const toRaw = getHeader(headers, 'To');
      const subject = getHeader(headers, 'Subject') || '(sans objet)';
      const dateStr = getHeader(headers, 'Date');
      const receivedAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
      const labelIds: string[] = msg.labelIds ?? [];

      const from = parseAddress(fromRaw);
      const to = parseAddress(toRaw);
      const dbRow = dbByGmailId.get(msg.id);

      return {
        gmail_id: msg.id,
        thread_id: msg.threadId ?? '',
        folder,
        from_email: from.email,
        from_name: from.name,
        to_email: to.email,
        to_name: to.name,
        subject,
        snippet: decodeHtmlEntities(msg.snippet ?? ''),
        received_at: receivedAt,
        is_unread: labelIds.includes('UNREAD'),
        is_starred: labelIds.includes('STARRED'),
        is_analyzed: !!dbRow,
        ...(dbRow ? {
          classification: dbRow.classification,
          email_db_id: dbRow.id,
          status: dbRow.status,
        } : {}),
      };
    });

    // ── 5. Trier par date desc ──
    emails.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime());

    return jsonResponse({
      emails,
      nextPageToken: listRes.data.nextPageToken ?? null,
    });

  } catch (err) {
    console.error('[gmail-inbox] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/gmail-inbox',
};

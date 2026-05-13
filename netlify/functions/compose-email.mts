// ============================================================
// POST /api/compose — Composer et envoyer un nouvel email
// Actions : draft (Claude rédige) | send (envoyer) | draft-gmail (sauvegarder brouillon)
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { getGmailClient, buildRawEmail, markAsRead, type OutgoingAttachment } from './_gmail.js';
import { composeEmail } from './_claude.js';

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Méthode non autorisée', 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action, to, cc, subject, content, instructions, attachments } = body as {
      action: 'draft' | 'send' | 'draft-gmail';
      to: string;
      cc?: string;
      subject?: string;
      content?: string;
      instructions?: string;
      attachments?: OutgoingAttachment[];
    };

    // ── ACTION : draft — Claude rédige l'email à partir des instructions ──
    if (action === 'draft') {
      if (!instructions) return errorResponse('Instructions requises', 400);
      if (!to) return errorResponse('Destinataire requis', 400);

      const db = getDb();
      const [guideRows, exampleRows] = await Promise.all([
        db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []),
        db`SELECT email_body, ideal_response, classification FROM examples ORDER BY created_at DESC LIMIT 20`.catch(() => []),
      ]);

      const guide = (guideRows[0] as any)?.content ?? '';
      const examples = exampleRows as any[];

      const result = await composeEmail({
        guide,
        examples,
        toEmail: to,
        subject: subject || undefined,
        instructions,
      });

      return jsonResponse({ success: true, subject: result.subject, body: result.body });
    }

    // ── ACTION : send — Envoyer l'email ──
    if (action === 'send') {
      if (!to) return errorResponse('Destinataire requis', 400);
      if (!content) return errorResponse('Contenu requis', 400);
      if (!subject) return errorResponse('Objet requis', 400);

      const gmail = getGmailClient();
      const senderEmail = (process.env.GMAIL_ADDRESS ?? 'contact@coachello.io').toLowerCase();

      const raw = buildRawEmail({
        to,
        from: senderEmail,
        subject,
        body: content,
        cc: cc || undefined,
        attachments,
      });

      const sendRes = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });

      // Marquer comme lu pour ne pas le réingérer (markAsRead attend un thread_id)
      if (sendRes.data.threadId) {
        await markAsRead(sendRes.data.threadId);
      }

      return jsonResponse({ success: true, action: 'sent', messageId: sendRes.data.id });
    }

    // ── ACTION : draft-gmail — Sauvegarder comme brouillon Gmail ──
    if (action === 'draft-gmail') {
      if (!to) return errorResponse('Destinataire requis', 400);
      if (!content) return errorResponse('Contenu requis', 400);
      if (!subject) return errorResponse('Objet requis', 400);

      const gmail = getGmailClient();
      const senderEmail = (process.env.GMAIL_ADDRESS ?? 'contact@coachello.io').toLowerCase();

      const raw = buildRawEmail({
        to,
        from: senderEmail,
        subject,
        body: content,
        cc: cc || undefined,
        attachments,
      });

      await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw } },
      });

      return jsonResponse({ success: true, action: 'draft_saved' });
    }

    return errorResponse(`Action inconnue : ${action}`, 400);

  } catch (err) {
    console.error('[compose-email] Erreur:', err);
    return errorResponse('Erreur serveur', 500);
  }
}

export const config: Config = {
  path: '/api/compose',
};

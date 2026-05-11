// ============================================================
// POST /api/analyze-email — Lance l'analyse Claude pour UN email précis
// Déclenché par le clic sur une ligne d'inbox non encore analysée
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { processOneEmail } from './_processOne.js';

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
    const threadId = body.thread_id as string | undefined;

    if (!gmailId) {
      return errorResponse('gmail_id requis', 400);
    }

    const db = getDb();

    // Si l'email est déjà en DB (analysé), on renvoie directement la row
    const existing = await db`
      SELECT id, gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails, subject,
             LEFT(body_text, 5000) AS body_text,
             body_html,
             LEFT(body_text, 200) AS body_preview,
             received_at, classification, reasoning,
             LEFT(draft_response, 300) AS draft_preview,
             draft_response, status, locked_by, locked_at,
             validated_at, validated_by, created_at,
             COALESCE(attachments, '[]'::jsonb) AS attachments
      FROM emails
      WHERE gmail_id = ${gmailId}
      LIMIT 1
    ` as any[];

    if (existing.length > 0) {
      return jsonResponse({ success: true, already_analyzed: true, email: existing[0] });
    }

    // Sinon, lancer l'analyse
    const result = await processOneEmail(gmailId, threadId);

    if (result.status === 'error') {
      return errorResponse(result.error, 500);
    }

    if (result.status === 'skipped') {
      return jsonResponse({ success: false, skipped: true, reason: result.reason }, 200);
    }

    // Recharger la row insérée avec tous les champs
    const inserted = await db`
      SELECT id, gmail_id, thread_id, message_id, from_email, from_name, to_email, cc_emails, subject,
             LEFT(body_text, 5000) AS body_text,
             body_html,
             LEFT(body_text, 200) AS body_preview,
             received_at, classification, reasoning,
             LEFT(draft_response, 300) AS draft_preview,
             draft_response, status, locked_by, locked_at,
             validated_at, validated_by, created_at,
             COALESCE(attachments, '[]'::jsonb) AS attachments
      FROM emails
      WHERE gmail_id = ${gmailId}
      LIMIT 1
    ` as any[];

    if (inserted.length === 0) {
      return errorResponse('Email inséré introuvable', 500);
    }

    return jsonResponse({ success: true, email: inserted[0] });

  } catch (err) {
    console.error('[analyze-email] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/analyze-email',
};

// ============================================================
// GET /api/emails — Récupérer la liste des emails (dashboard)
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';

export default async function handler(req: Request) {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return errorResponse('Méthode non autorisée', 405);
  }

  try {
    const db  = getDb();
    const url = new URL(req.url);

    // Filtres optionnels
    const status         = url.searchParams.get('status');         // pending, locked, validated...
    const classification = url.searchParams.get('classification'); // URGENT, IMPORTANT...
    const limit          = parseInt(url.searchParams.get('limit') ?? '100');
    const offset         = parseInt(url.searchParams.get('offset') ?? '0');

    let emails;

    if (status && classification) {
      emails = await db`
        SELECT id, gmail_id, thread_id, from_email, from_name, subject,
               LEFT(body_text, 5000) AS body_text,
               LEFT(body_text, 200) AS body_preview,
               received_at, classification, reasoning,
               LEFT(draft_response, 300) AS draft_preview,
               draft_response, status, locked_by, locked_at,
               validated_at, validated_by, created_at,
               COALESCE(attachments, '[]'::jsonb) AS attachments
        FROM emails
        WHERE status = ${status} AND classification = ${classification}
        ORDER BY
          CASE classification
            WHEN 'URGENT'    THEN 1
            WHEN 'IMPORTANT' THEN 2
            WHEN 'NORMAL'    THEN 3
            WHEN 'FAIBLE'    THEN 4
          END,
          received_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (status) {
      emails = await db`
        SELECT id, gmail_id, thread_id, from_email, from_name, subject,
               LEFT(body_text, 5000) AS body_text,
               LEFT(body_text, 200) AS body_preview,
               received_at, classification, reasoning,
               LEFT(draft_response, 300) AS draft_preview,
               draft_response, status, locked_by, locked_at,
               validated_at, validated_by, created_at,
               COALESCE(attachments, '[]'::jsonb) AS attachments
        FROM emails
        WHERE status = ${status}
        ORDER BY
          CASE classification
            WHEN 'URGENT'    THEN 1
            WHEN 'IMPORTANT' THEN 2
            WHEN 'NORMAL'    THEN 3
            WHEN 'FAIBLE'    THEN 4
          END,
          received_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      // Par défaut : les emails en attente de validation
      emails = await db`
        SELECT id, gmail_id, thread_id, from_email, from_name, subject,
               LEFT(body_text, 5000) AS body_text,
               LEFT(body_text, 200) AS body_preview,
               received_at, classification, reasoning,
               LEFT(draft_response, 300) AS draft_preview,
               draft_response, status, locked_by, locked_at,
               validated_at, validated_by, created_at,
               COALESCE(attachments, '[]'::jsonb) AS attachments
        FROM emails
        WHERE status IN ('pending', 'locked')
        ORDER BY
          CASE classification
            WHEN 'URGENT'    THEN 1
            WHEN 'IMPORTANT' THEN 2
            WHEN 'NORMAL'    THEN 3
            WHEN 'FAIBLE'    THEN 4
          END,
          received_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    // Statistiques pour le dashboard
    const stats = await db`
      SELECT
        classification,
        status,
        COUNT(*) AS count
      FROM emails
      GROUP BY classification, status
    `;

    return jsonResponse({ emails, stats });

  } catch (err) {
    console.error('[get-emails] Erreur:', err);
    return errorResponse('Erreur serveur', 500);
  }
}

export const config: Config = {
  path: '/api/emails',
};

// ============================================================
// POST /api/analyze-email — Endpoint léger (DB-only)
//
// Comportement :
//   1. SELECT sur la DB :
//      - si l'email existe → renvoie la row immédiatement
//      - sinon, premier appel : déclenche la fonction background
//        analyze-email-background (fire-and-forget) et renvoie { queued: true }
//      - sinon, body.poll === true : renvoie { pending: true }
//        (le front polle tant que ni email ni skipped n'est revenu)
//
// L'analyse Claude (qui peut dépasser 30s) tourne dans la fonction
// background pour ne plus déclencher de timeout HTTP côté Netlify.
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';

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
    const poll = body.poll === true;

    if (!gmailId) {
      return errorResponse('gmail_id requis', 400);
    }

    const db = getDb();

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
      return jsonResponse({ success: true, email: existing[0] });
    }

    if (poll) {
      return jsonResponse({ success: true, pending: true });
    }

    // Premier appel : déclencher la fonction background (fire-and-forget)
    const origin = new URL(req.url).origin;
    fetch(`${origin}/.netlify/functions/analyze-email-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gmail_id: gmailId, thread_id: threadId }),
    }).catch(err => console.error('[analyze-email] échec déclenchement background:', err));

    return jsonResponse({ success: true, queued: true });

  } catch (err) {
    console.error('[analyze-email] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/analyze-email',
};

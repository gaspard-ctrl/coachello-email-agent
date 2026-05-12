// ============================================================
// POST /api/redraft — Régénération synchrone du brouillon avec contexte
// (anciennement en background, qui ne renvoyait jamais le draft au front)
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { classifyAndDraftEmail } from './_claude.js';

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Méthode non autorisée', 405);
  }

  try {
    const { emailId, context } = await req.json().catch(() => ({})) as { emailId?: string; context?: string };
    if (!emailId || !context?.trim()) {
      return errorResponse('emailId et context requis', 400);
    }

    const db = getDb();

    const [emailRows, guideRows, exampleRows, ruleRows] = await Promise.all([
      db`SELECT * FROM emails WHERE id = ${emailId}`,
      db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []),
      db`SELECT email_body, ideal_response, classification FROM examples ORDER BY created_at DESC LIMIT 20`.catch(() => []),
      db`SELECT rule_type, value, classification FROM classification_rules`.catch(() => []),
    ]);

    const email = (emailRows as any[])[0];
    if (!email) {
      return errorResponse('Email introuvable', 404);
    }

    const result = await classifyAndDraftEmail({
      guide:     (guideRows[0] as any)?.content ?? '',
      examples:  exampleRows as any[],
      rules:     ruleRows as any[],
      fromEmail: email.from_email,
      fromName:  email.from_name,
      subject:   email.subject,
      body:      email.body_text ?? '',
      context,
    });

    await db`UPDATE emails SET draft_response = ${result.draft_response} WHERE id = ${emailId}`;
    console.log(`[redraft] ✓ ${emailId} brouillon régénéré`);

    return jsonResponse({ success: true, draft_response: result.draft_response });

  } catch (err) {
    console.error('[redraft] Erreur:', err);
    return errorResponse(String(err), 500);
  }
}

export const config: Config = {
  path: '/api/redraft',
};

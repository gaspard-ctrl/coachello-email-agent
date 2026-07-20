// ============================================================
// GET/POST /api/settings — Paramètres globaux clé-valeur
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';

const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

async function ensureTable(db: ReturnType<typeof getDb>) {
  await db`
    CREATE TABLE IF NOT EXISTS settings (
      key         VARCHAR(100) PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TIMESTAMP DEFAULT NOW()
    )
  `.catch(() => {});
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const db = getDb();
  await ensureTable(db);

  if (req.method === 'GET') {
    const rows = await db`SELECT key, value FROM settings`;
    const settings: Record<string, string> = {};
    for (const r of rows as any[]) settings[r.key] = r.value;
    // Adresse de la boîte gérée (env) — exposée pour que le front sache "qui est moi"
    // (ex : exclure notre propre adresse des destinataires en Cc d'une réponse).
    settings.gmail_address = (process.env.GMAIL_ADDRESS ?? '').toLowerCase();
    return jsonResponse({ settings });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => null) as { key?: string; value?: string } | null;
    if (!body?.key || typeof body.value !== 'string') {
      return errorResponse('"key" et "value" requis', 400);
    }
    if (body.key === 'claude_model' && !ALLOWED_MODELS.includes(body.value)) {
      return errorResponse(`Modèle non autorisé. Valeurs : ${ALLOWED_MODELS.join(', ')}`, 400);
    }
    await db`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${body.key}, ${body.value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return jsonResponse({ success: true });
  }

  return errorResponse('Méthode non autorisée', 405);
}

export const config: Config = {
  path: '/api/settings',
};

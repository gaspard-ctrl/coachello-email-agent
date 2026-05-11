// ============================================================
// GET /api/usage — Statistiques de coût Claude (bot)
// ============================================================
import type { Config } from '@netlify/functions';
import { getDb, corsHeaders, jsonResponse } from './_db.js';

// Tarifs Anthropic (USD / 1M tokens). Doit rester synchro avec _claude.ts
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':           { input: 3, output: 15 },
  'claude-haiku-4-5-20251001':   { input: 1, output: 5  },
};

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Méthode non autorisée' }, 405);
  }

  // Mode debug : prouve que la fonction se charge et tourne
  if (new URL(req.url).searchParams.get('debug') === '1') {
    return jsonResponse({ ok: true, hasDbUrl: !!process.env.DATABASE_URL });
  }

  try {
    const db = getDb();

    // S'assurer que la table existe (idempotent)
    try {
      await db`
        CREATE TABLE IF NOT EXISTS claude_usage (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          function_name         VARCHAR(100) NOT NULL,
          model                 VARCHAR(100) NOT NULL,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd              NUMERIC(10, 6) NOT NULL DEFAULT 0,
          email_id              UUID,
          email_subject         TEXT,
          created_at            TIMESTAMP DEFAULT NOW()
        )
      `;
    } catch (e) {
      console.error('[usage] CREATE TABLE failed:', e);
    }

    const totals = await db`
      SELECT
        COUNT(*)::int                                                                            AS total_calls,
        COALESCE(SUM(cost_usd), 0)::float                                                        AS total_cost,
        COALESCE(SUM(input_tokens), 0)::int                                                      AS total_input,
        COALESCE(SUM(output_tokens), 0)::int                                                     AS total_output,
        COALESCE(SUM(cache_read_tokens), 0)::int                                                 AS total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0)::int                                             AS total_cache_creation,
        COALESCE(SUM(cost_usd) FILTER (WHERE function_name = 'classifyAndDraftEmail'), 0)::float AS classify_cost,
        COUNT(*) FILTER (WHERE function_name = 'classifyAndDraftEmail')::int                     AS classify_calls,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::float AS cost_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int                   AS calls_24h,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::float  AS cost_7d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int                     AS calls_7d,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::float AS cost_30d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int                    AS calls_30d,
        MIN(created_at)                                                                          AS first_call_at,
        MAX(created_at)                                                                          AS last_call_at
      FROM claude_usage
    `;
    const totalsRow = (totals as any[])[0] ?? {};

    const byFunction = await db`
      SELECT function_name, model,
             COUNT(*)::int                          AS calls,
             COALESCE(SUM(cost_usd),0)::float       AS cost,
             COALESCE(SUM(input_tokens),0)::int     AS input_tokens,
             COALESCE(SUM(output_tokens),0)::int    AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)::int     AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens),0)::int AS cache_creation_tokens
      FROM claude_usage
      GROUP BY function_name, model
      ORDER BY cost DESC
    `;

    const byModel = await db`
      SELECT model,
             COUNT(*)::int                          AS calls,
             COALESCE(SUM(cost_usd),0)::float       AS cost,
             COALESCE(SUM(input_tokens),0)::int     AS input_tokens,
             COALESCE(SUM(output_tokens),0)::int    AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)::int     AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens),0)::int AS cache_creation_tokens
      FROM claude_usage
      GROUP BY model
      ORDER BY cost DESC
    `;

    const byDay = await db`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             COUNT(*)::int                       AS calls,
             COALESCE(SUM(cost_usd),0)::float    AS cost,
             COALESCE(SUM(input_tokens),0)::int  AS input_tokens,
             COALESCE(SUM(output_tokens),0)::int AS output_tokens
      FROM claude_usage
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const log = await db`
      SELECT id, function_name, model,
             input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens,
             cost_usd::float AS cost_usd,
             email_subject, created_at
      FROM claude_usage
      ORDER BY created_at DESC
      LIMIT 500
    `;

    const totalCalls    = totalsRow.total_calls    ?? 0;
    const totalCost     = totalsRow.total_cost     ?? 0;
    const classifyCalls = totalsRow.classify_calls ?? 0;
    const classifyCost  = totalsRow.classify_cost  ?? 0;
    const avgPerEmail   = classifyCalls > 0 ? classifyCost / classifyCalls : 0;
    const avgPerCall    = totalCalls > 0 ? totalCost / totalCalls : 0;

    return jsonResponse({
      summary: {
        total_calls:          totalCalls,
        total_cost:           totalCost,
        total_input:          totalsRow.total_input ?? 0,
        total_output:         totalsRow.total_output ?? 0,
        total_cache_read:     totalsRow.total_cache_read ?? 0,
        total_cache_creation: totalsRow.total_cache_creation ?? 0,
        emails_processed:     classifyCalls,
        avg_cost_per_email:   avgPerEmail,
        avg_cost_per_call:    avgPerCall,
        classify_cost:        classifyCost,
        cost_24h:             totalsRow.cost_24h ?? 0,
        calls_24h:            totalsRow.calls_24h ?? 0,
        cost_7d:              totalsRow.cost_7d ?? 0,
        calls_7d:             totalsRow.calls_7d ?? 0,
        cost_30d:             totalsRow.cost_30d ?? 0,
        calls_30d:            totalsRow.calls_30d ?? 0,
        first_call_at:        totalsRow.first_call_at,
        last_call_at:         totalsRow.last_call_at,
      },
      pricing: PRICING,
      by_function: byFunction,
      by_model: byModel,
      by_day: byDay,
      log,
    });
  } catch (err: any) {
    console.error('[usage] Erreur:', err);
    return jsonResponse(
      { error: `Erreur serveur : ${err?.message ?? String(err)}` },
      500
    );
  }
}

export const config: Config = {
  path: '/api/usage',
};

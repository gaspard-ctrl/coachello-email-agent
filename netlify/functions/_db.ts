// ============================================================
// Helper partagé : connexion à la base PostgreSQL (Supabase / Neon)
// ============================================================
import postgres from 'postgres';

// Singleton — réutilise la même pool sur les invocations warm (évite le cold start DB à chaque requête)
let _db: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL manquant dans les variables d\'environnement');
    // max=10 : laisse de la marge pour les Promise.all (3-5 queries concurrentes) sans
    // saturer la pool. Auparavant max=2 + auto-migration au cold start saturait tout
    // et bloquait analyze-email pendant ~30s sur sa toute première invocation.
    _db = postgres(url, { ssl: 'require', max: 10, connect_timeout: 10, idle_timeout: 60 });
  }
  return _db;
}

export type EmailStatus = 'pending' | 'locked' | 'validated' | 'rejected' | 'sent' | 'draft_saved';
export type Classification = 'URGENT' | 'IMPORTANT' | 'NORMAL' | 'FAIBLE';

export interface EmailRow {
  id: string;
  gmail_id: string;
  thread_id: string;
  message_id: string;
  from_email: string;
  from_name: string;
  to_email: string;
  cc_emails: string;
  subject: string;
  body_text: string;
  received_at: string;
  classification: Classification;
  reasoning: string;
  draft_response: string;
  status: EmailStatus;
  locked_by: string | null;
  locked_at: string | null;
  validated_at: string | null;
  validated_by: string | null;
  final_response: string | null;
  created_at: string;
}

// CORS headers pour toutes les fonctions
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message: string, status = 500) {
  return jsonResponse({ error: message }, status);
}

// ============================================================
// Helper partagé : connexion à la base PostgreSQL (Supabase)
// ============================================================
import postgres from 'postgres';

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant dans les variables d\'environnement');
  return postgres(url, { ssl: 'require', max: 1, connect_timeout: 10, idle_timeout: 20 });
}

export type EmailStatus = 'pending' | 'locked' | 'validated' | 'rejected' | 'sent' | 'draft_saved';
export type Classification = 'URGENT' | 'IMPORTANT' | 'NORMAL' | 'FAIBLE';

export interface EmailRow {
  id: string;
  gmail_id: string;
  thread_id: string;
  from_email: string;
  from_name: string;
  to_email: string;
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

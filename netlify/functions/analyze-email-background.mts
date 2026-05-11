// ============================================================
// Background Function — Analyse Claude d'UN email à la demande
// Filename -background → Netlify retourne 202 immédiatement,
// ce handler tourne en async jusqu'à 15 minutes (pas de timeout HTTP)
// ============================================================
import { getDb } from './_db.js';
import { processOneEmail } from './_processOne.js';

export default async function handler(req: Request): Promise<void> {
  const body = await req.json().catch(() => ({})) as { gmail_id?: string; thread_id?: string };
  const gmailId = body.gmail_id;
  const threadId = body.thread_id;
  if (!gmailId) return;

  // Idempotence : si l'email est déjà en DB (déclenchement multiple), on sort
  const db = getDb();
  const existing = await db`SELECT id FROM emails WHERE gmail_id = ${gmailId} LIMIT 1` as any[];
  if (existing.length > 0) {
    console.log(`[analyze-email-bg] ${gmailId} déjà en DB — skip`);
    return;
  }

  const result = await processOneEmail(gmailId, threadId);
  console.log(`[analyze-email-bg] ${gmailId} → ${result.status}`);
}

// ============================================================
// Background Function — Régénération brouillon avec contexte
// Filename -background → Netlify retourne 202 immédiatement,
// ce handler tourne en async jusqu'à 15 minutes (pas de timeout HTTP)
// ============================================================
import { getDb } from './_db.js';
import { classifyAndDraftEmail } from './_claude.js';

// PAS de Config.path — le routing est géré par netlify.toml
// Le emailId est lu depuis le body de la requête

export default async function handler(req: Request): Promise<void> {
  const { emailId, context } = await req.json().catch(() => ({})) as { emailId?: string; context?: string };
  if (!emailId || !context?.trim()) return;

  const db = getDb();

  const [emailRows, guideRows, exampleRows, ruleRows] = await Promise.all([
    db`SELECT * FROM emails WHERE id = ${emailId}`,
    db`SELECT content FROM guide ORDER BY updated_at DESC LIMIT 1`.catch(() => []),
    db`SELECT email_body, ideal_response, classification FROM examples ORDER BY created_at DESC LIMIT 8`.catch(() => []),
    db`SELECT rule_type, value, classification FROM rules`.catch(() => []),
  ]);

  const email = (emailRows as any[])[0];
  if (!email) return;

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
  console.log(`[redraft-bg] ✓ ${emailId} brouillon régénéré`);
}

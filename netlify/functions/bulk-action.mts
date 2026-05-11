// ============================================================
// POST /api/bulk-action
// Body: { action: 'mark-read' | 'trash', classification: 'FAIBLE' }
// ============================================================
import { getDb, corsHeaders, jsonResponse, errorResponse } from './_db.js';
import { markAsRead, getGmailClient } from './_gmail.js';

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return errorResponse('Méthode non autorisée', 405);
  }

  const body = await req.json().catch(() => ({})) as any;
  const { action, classification } = body as { action: string; classification: string };

  if (!['mark-read', 'trash'].includes(action) || !classification) {
    return errorResponse('Paramètres invalides', 400);
  }

  const db = getDb();

  // Récupérer tous les emails de cette classification (pending ou locked)
  const rows = await db`
    SELECT id, gmail_id FROM emails
    WHERE classification = ${classification}
      AND status IN ('pending', 'locked')
  `;

  if ((rows as any[]).length === 0) {
    return jsonResponse({ success: true, updated: 0 });
  }

  const gmailIds = (rows as any[]).map((r: any) => r.gmail_id).filter(Boolean);

  if (action === 'trash') {
    // Déplacer dans la corbeille Gmail + supprimer de la DB
    const gmail = getGmailClient();
    const results = await Promise.allSettled(
      gmailIds.map((gmailId: string) =>
        gmail.users.messages.trash({ userId: 'me', id: gmailId })
      )
    );
    const succeeded = new Set(gmailIds.filter((_, i) => results[i].status === 'fulfilled'));
    const idsToDelete = (rows as any[])
      .filter((r: any) => !r.gmail_id || succeeded.has(r.gmail_id))
      .map((r: any) => r.id);
    if (idsToDelete.length > 0) {
      await db`DELETE FROM emails WHERE id = ANY(${idsToDelete}::uuid[])`;
    }
    return jsonResponse({ success: true, deleted: idsToDelete.length, failed: gmailIds.length - succeeded.size });
  }

  // action === 'mark-read'
  const results = await Promise.allSettled(
    gmailIds.map((gmailId: string) => markAsRead(gmailId))
  );
  const succeededGmailIds = new Set(
    gmailIds.filter((_, i) => results[i].status === 'fulfilled' && (results[i] as PromiseFulfilledResult<boolean>).value === true)
  );
  const idsToDelete = (rows as any[]).filter((r: any) => !r.gmail_id || succeededGmailIds.has(r.gmail_id)).map((r: any) => r.id);
  const idsToKeep   = (rows as any[]).filter((r: any) => r.gmail_id && !succeededGmailIds.has(r.gmail_id)).map((r: any) => r.id);

  if (idsToDelete.length > 0) {
    await db`DELETE FROM emails WHERE id = ANY(${idsToDelete}::uuid[])`;
  }
  if (idsToKeep.length > 0) {
    await db`UPDATE emails SET status = 'rejected' WHERE id = ANY(${idsToKeep}::uuid[])`;
  }

  return jsonResponse({ success: true, updated: (rows as any[]).length });
}

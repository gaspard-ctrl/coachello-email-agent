// Cache module-level pour que le Dashboard se ré-affiche instantanément quand on
// revient depuis Admin. Non persistant — vit le temps de l'onglet.

import { apiGet } from './api'
import type { Email, GmailEmail } from '../types'

export interface InboxCache {
  gmailEmails?: GmailEmail[]
  analyzedEmails?: Email[]
  sentEmails?: GmailEmail[]
  nextPageToken?: string | null
  unreadCount?: number
  draftCount?: number
  lastFetchAt?: number
}

export const inboxCache: InboxCache = {}

export function resetInboxCache() {
  for (const k of Object.keys(inboxCache)) delete (inboxCache as Record<string, unknown>)[k]
}

let inflight: Promise<void> | null = null

/** Préchargement fire-and-forget — no-op si le cache est chaud. */
export function prefetchInbox(): Promise<void> {
  if (inboxCache.gmailEmails && inboxCache.analyzedEmails) return Promise.resolve()
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const [inboxRes, analyzedRes, countRes, draftsRes] = await Promise.all([
        apiGet<{ emails: GmailEmail[]; nextPageToken: string | null }>('/gmail-inbox?folder=inbox&limit=50').catch(() => null),
        apiGet<{ emails: Email[] }>('/emails').catch(() => null),
        apiGet<{ count: number }>('/manual-poll?count=true').catch(() => null),
        apiGet<{ drafts: number }>('/manual-poll?drafts=true').catch(() => null),
      ])
      if (inboxRes) {
        inboxCache.gmailEmails = inboxRes.emails
        inboxCache.nextPageToken = inboxRes.nextPageToken
      }
      if (analyzedRes) inboxCache.analyzedEmails = analyzedRes.emails ?? []
      if (countRes && typeof countRes.count === 'number') inboxCache.unreadCount = countRes.count
      if (draftsRes && typeof draftsRes.drafts === 'number') inboxCache.draftCount = draftsRes.drafts
      inboxCache.lastFetchAt = Date.now()
    } finally {
      inflight = null
    }
  })()

  return inflight
}

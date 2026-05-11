import { useState, useEffect, useCallback, useMemo, Component } from 'react'
import { createPortal } from 'react-dom'
import type { Email, GmailEmail, Classification } from '../types'
import EmailList from './EmailList'
import EmailDetail from './EmailDetail'
import ComposeEmail from './ComposeEmail'
import { apiGet, apiPost, apiFetch } from '../lib/api'
import { inboxCache } from '../lib/inboxCache'

class ModalErrorBoundary extends Component<
  { onClose: () => void; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="bg-white rounded-xl p-8 max-w-lg mx-auto shadow-2xl">
          <p className="text-red-600 font-semibold mb-2">Erreur d'affichage</p>
          <pre className="text-xs text-gray-600 bg-gray-50 p-3 rounded overflow-auto mb-4">
            {(this.state.error as Error).message}
          </pre>
          <button onClick={this.props.onClose} className="btn-ghost text-sm">Fermer</button>
        </div>
      )
    }
    return this.props.children
  }
}

type Filter = 'all' | Classification | 'unanalyzed'

const FILTERS: { key: Filter; label: string; dot?: string }[] = [
  { key: 'all',         label: 'Tous' },
  { key: 'URGENT',      label: 'Urgent',    dot: 'bg-[#F0024F]' },
  { key: 'IMPORTANT',   label: 'Important', dot: 'bg-[#F768A8]' },
  { key: 'NORMAL',      label: 'Normal',    dot: 'bg-[#FBBED7]' },
  { key: 'FAIBLE',      label: 'Faible',    dot: 'bg-[#FDE8F2] border border-[#C8A0BE]' },
  { key: 'unanalyzed',  label: 'Non analysé', dot: 'bg-[#EDE8E0] border border-[#D8D0C5]' },
]

export default function Dashboard() {
  // Inbox Gmail (toutes les lignes — analysées ou non)
  const [gmailEmails, setGmailEmails] = useState<GmailEmail[]>(inboxCache.gmailEmails ?? [])
  const [analyzedEmails, setAnalyzedEmails] = useState<Email[]>(inboxCache.analyzedEmails ?? [])
  const [nextPageToken, setNextPageToken] = useState<string | null>(inboxCache.nextPageToken ?? null)

  const [filter, setFilter] = useState<Filter>('all')
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  const [loading, setLoading] = useState(gmailEmails.length === 0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [polling, setPolling] = useState(false)
  const [pollResult, setPollResult] = useState<string | null>(null)
  const [pollProgress, setPollProgress] = useState<{ done: number; total: number } | null>(null)
  const [unreadCount, setUnreadCount] = useState<number | null>(inboxCache.unreadCount ?? null)
  const [draftCount, setDraftCount] = useState<number>(inboxCache.draftCount ?? 0)

  const [composing, setComposing] = useState(false)
  const [forwardPrefill, setForwardPrefill] = useState<{ subject: string; body: string } | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageData, setUsageData] = useState<any>(null)
  const [usageLoading, setUsageLoading] = useState(false)

  // ─────────────────────────────────────────────────────────────
  // Fetch helpers
  // ─────────────────────────────────────────────────────────────
  const fetchInbox = useCallback(async () => {
    try {
      const data = await apiGet<{ emails: GmailEmail[]; nextPageToken: string | null }>('/gmail-inbox?folder=inbox&limit=50')
      setGmailEmails(data.emails)
      setNextPageToken(data.nextPageToken)
      inboxCache.gmailEmails = data.emails
      inboxCache.nextPageToken = data.nextPageToken
      setLastRefresh(new Date())
    } catch (err) {
      console.error('Erreur fetchInbox:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAnalyzed = useCallback(async () => {
    try {
      const data = await apiGet<{ emails: Email[] }>('/emails')
      const emails = data.emails ?? []
      setAnalyzedEmails(emails)
      inboxCache.analyzedEmails = emails
    } catch (err) {
      console.error('Erreur fetchAnalyzed:', err)
    }
  }, [])

  const fetchCounts = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([
        apiGet<{ count: number }>('/manual-poll?count=true').catch(() => null),
        apiGet<{ drafts: number }>('/manual-poll?drafts=true').catch(() => null),
      ])
      if (c && typeof c.count === 'number') { setUnreadCount(c.count); inboxCache.unreadCount = c.count }
      if (d && typeof d.drafts === 'number') { setDraftCount(d.drafts); inboxCache.draftCount = d.drafts }
    } catch {/* silent */}
  }, [])

  const syncRead = useCallback(async () => {
    await apiFetch('/sync-read').catch(() => {})
  }, [])

  const refreshAll = useCallback(async () => {
    await syncRead()
    await Promise.all([fetchInbox(), fetchAnalyzed()])
    fetchCounts()
  }, [fetchInbox, fetchAnalyzed, fetchCounts, syncRead])

  // Au mount : si rien en cache, fetch ; sinon refresh en arrière-plan
  useEffect(() => {
    refreshAll()
    const interval = setInterval(refreshAll, 2 * 60 * 1000)
    const onRefresh = () => { refreshAll() }
    window.addEventListener('dashboard:refresh', onRefresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('dashboard:refresh', onRefresh)
    }
  }, [refreshAll])

  // ─────────────────────────────────────────────────────────────
  // Merge & filter
  // ─────────────────────────────────────────────────────────────
  const analyzedByGmailId = useMemo(() => {
    const map = new Map<string, Email>()
    for (const e of analyzedEmails) map.set(e.gmail_id, e)
    return map
  }, [analyzedEmails])

  // Enrichir gmailEmails avec les infos d'analyse fraîches de la DB
  const enrichedInbox = useMemo<GmailEmail[]>(() => {
    return gmailEmails.map(e => {
      const dbRow = analyzedByGmailId.get(e.gmail_id)
      if (dbRow) {
        return {
          ...e,
          is_analyzed: true,
          classification: dbRow.classification,
          email_db_id: dbRow.id,
          status: dbRow.status,
        }
      }
      return e
    })
  }, [gmailEmails, analyzedByGmailId])

  const counts = useMemo(() => {
    // Compteurs des classifications : tirés de analyzedEmails (set complet
    // de la DB, jusqu'à 100 emails — non borné à la page Gmail courante).
    // 'all' et 'unanalyzed' ne peuvent pas être globaux (Gmail paginé) → non affichés.
    const c: Record<Filter, number> = { all: 0, URGENT: 0, IMPORTANT: 0, NORMAL: 0, FAIBLE: 0, unanalyzed: 0 }
    for (const e of analyzedEmails) {
      if (e.classification) c[e.classification]++
    }
    return c
  }, [analyzedEmails])

  const filteredEmails = useMemo(() => {
    let list: GmailEmail[]
    if (filter === 'all') {
      // Page Gmail courante uniquement
      list = enrichedInbox
    } else if (filter === 'unanalyzed') {
      // Page Gmail courante uniquement (non-analysés)
      list = enrichedInbox.filter(e => !e.is_analyzed)
    } else {
      // Filtre par classification → on prend TOUS les emails analysés de la DB
      // (peut inclure des emails hors page Gmail courante).
      // On préfère la version "enrichedInbox" si l'email est dans la page (pour
      // récupérer is_unread, snippet réel, etc.), sinon on convertit la row DB.
      const inboxByGmailId = new Map(enrichedInbox.map(e => [e.gmail_id, e]))
      list = analyzedEmails
        .filter(e => e.classification === filter)
        .map(e => {
          const fromInbox = inboxByGmailId.get(e.gmail_id)
          if (fromInbox) return fromInbox
          // Fallback : on construit un GmailEmail à partir de la row DB
          return {
            gmail_id: e.gmail_id,
            thread_id: e.thread_id,
            folder: 'inbox' as const,
            from_email: e.from_email,
            from_name: e.from_name,
            to_email: e.to_email,
            to_name: '',
            subject: e.subject || '(sans objet)',
            snippet: e.body_preview ?? '',
            received_at: e.received_at,
            is_unread: true, // par défaut — la row DB ne stocke pas l'état Gmail
            is_starred: false,
            is_analyzed: true,
            classification: e.classification,
            email_db_id: e.id,
            status: e.status,
          } satisfies GmailEmail
        })
    }

    // Regroupement par thread_id : on garde le message le plus récent comme
    // représentant, on note le total et on marque non-lu si au moins un est non-lu.
    const byThread = new Map<string, GmailEmail[]>()
    for (const e of list) {
      const tid = e.thread_id || e.gmail_id
      const arr = byThread.get(tid) ?? []
      arr.push(e)
      byThread.set(tid, arr)
    }
    const grouped: GmailEmail[] = []
    for (const emails of byThread.values()) {
      const sorted = [...emails].sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime())
      const latest = sorted[0]
      // Préférer une row analysée si dispo (pour avoir la classification)
      const analyzed = sorted.find(e => e.is_analyzed)
      grouped.push({
        ...latest,
        is_analyzed: analyzed ? true : latest.is_analyzed,
        classification: analyzed?.classification ?? latest.classification,
        email_db_id: analyzed?.email_db_id ?? latest.email_db_id,
        status: analyzed?.status ?? latest.status,
        is_unread: emails.some(e => e.is_unread),
        thread_count: emails.length,
      })
    }
    grouped.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime())
    return grouped
  }, [enrichedInbox, filter])

  // ─────────────────────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────────────────────
  const handleSelect = (g: GmailEmail) => {
    setAnalyzing(false)
    // Cas 1 : déjà analysé → on a la row DB en mémoire
    if (g.is_analyzed && g.email_db_id) {
      const dbRow = analyzedByGmailId.get(g.gmail_id)
      if (dbRow) {
        setSelectedEmail(dbRow)
        return
      }
    }
    // Cas 2 : non analysé → ouvrir la modale en preview, l'analyse sera lancée
    //         manuellement via le bouton "Analyser cet email"
    setSelectedEmail({
      id: 'tmp-' + g.gmail_id,
      gmail_id: g.gmail_id,
      thread_id: g.thread_id,
      from_email: g.from_email,
      from_name: g.from_name,
      to_email: g.to_email,
      subject: g.subject || '(sans objet)',
      body_text: g.snippet,
      body_preview: g.snippet,
      received_at: g.received_at,
      classification: 'NORMAL',
      reasoning: '',
      draft_response: '',
      status: 'pending',
      locked_by: null,
      locked_at: null,
      validated_at: null,
      validated_by: null,
      final_response: null,
      created_at: new Date().toISOString(),
    })
  }

  const runAnalysis = async () => {
    if (!selectedEmail) return
    setAnalyzing(true)
    try {
      const res = await apiPost<{ success: boolean; email?: Email; skipped?: boolean; reason?: string }>(
        '/analyze-email',
        { gmail_id: selectedEmail.gmail_id, thread_id: selectedEmail.thread_id },
      )
      if (res.email) {
        setSelectedEmail(res.email)
        setAnalyzedEmails(prev => {
          const next = prev.filter(e => e.gmail_id !== res.email!.gmail_id).concat(res.email!)
          inboxCache.analyzedEmails = next
          return next
        })
      } else if (res.skipped) {
        setPollResult(`Email ignoré (${res.reason ?? 'raison inconnue'})`)
        setTimeout(() => setPollResult(null), 4000)
        setSelectedEmail(null)
      }
    } catch (err) {
      setPollResult(`Erreur analyse : ${err instanceof Error ? err.message : 'inconnue'}`)
      setTimeout(() => setPollResult(null), 4000)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleClose = () => {
    setSelectedEmail(null)
    setAnalyzing(false)
    refreshAll()
  }

  const handleForward = (e: Email) => {
    const fromLine = e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email
    const dateLine = new Date(e.received_at).toLocaleString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
    const subj = e.subject || '(sans objet)'
    const originalBody = e.body_text || e.body_preview || ''
    const fwdSubject = /^fwd?\s*:/i.test(subj) ? subj : `Fwd: ${subj}`
    const fwdBody = [
      '',
      '',
      '---------- Message transféré ----------',
      `De : ${fromLine}`,
      `Date : ${dateLine}`,
      `Objet : ${subj}`,
      `À : ${e.to_email}`,
      ...(e.cc_emails ? [`Cc : ${e.cc_emails}`] : []),
      '',
      originalBody,
    ].join('\n')
    setForwardPrefill({ subject: fwdSubject, body: fwdBody })
    setSelectedEmail(null)
    setAnalyzing(false)
    setComposing(true)
  }

  const handleAction = () => {
    const emailId = selectedEmail?.id
    setSelectedEmail(null)
    setAnalyzing(false)
    if (emailId) {
      setAnalyzedEmails(prev => {
        const next = prev.filter(e => e.id !== emailId)
        inboxCache.analyzedEmails = next
        return next
      })
    }
    refreshAll()
  }

  const handleToggleRead = useCallback(async (gmailId: string, currentlyUnread: boolean) => {
    const newUnread = !currentlyUnread
    // Update optimiste : la ligne de la liste + tous les messages du thread
    const target = gmailEmails.find(e => e.gmail_id === gmailId)
    const threadId = target?.thread_id
    setGmailEmails(prev => prev.map(e => {
      if (e.gmail_id === gmailId || (threadId && e.thread_id === threadId)) {
        return { ...e, is_unread: newUnread }
      }
      return e
    }))
    try {
      await apiPost('/mark-read', { gmail_id: gmailId, unread: newUnread })
    } catch (err) {
      console.error('[mark-read] failed:', err)
      // Revert
      setGmailEmails(prev => prev.map(e => {
        if (e.gmail_id === gmailId || (threadId && e.thread_id === threadId)) {
          return { ...e, is_unread: currentlyUnread }
        }
        return e
      }))
    }
    fetchCounts()
  }, [gmailEmails, fetchCounts])

  const handleLoadMore = async () => {
    if (!nextPageToken || loadingMore) return
    setLoadingMore(true)
    try {
      const data = await apiGet<{ emails: GmailEmail[]; nextPageToken: string | null }>(
        `/gmail-inbox?folder=inbox&limit=50&pageToken=${encodeURIComponent(nextPageToken)}`,
      )
      const next = [...gmailEmails, ...data.emails]
      setGmailEmails(next)
      setNextPageToken(data.nextPageToken)
      inboxCache.gmailEmails = next
      inboxCache.nextPageToken = data.nextPageToken
    } catch (err) {
      console.error('Erreur loadMore:', err)
    } finally {
      setLoadingMore(false)
    }
  }

  const [readingFaible, setReadingFaible] = useState(false)
  const handleReadFaible = async () => {
    const n = counts.FAIBLE
    if (n === 0 || readingFaible) return
    if (!window.confirm(`Marquer ${n} email${n > 1 ? 's' : ''} "Faible" comme lu${n > 1 ? 's' : ''} ?\n\nLes messages restent dans Gmail mais sortent de l'inbox (label UNREAD retiré) et sont retirés du dashboard.`)) {
      return
    }
    setReadingFaible(true)
    // Retirer optimistement de la liste
    const targetGmailIds = new Set(enrichedInbox.filter(e => e.is_analyzed && e.classification === 'FAIBLE').map(e => e.gmail_id))
    setGmailEmails(prev => prev.filter(e => !targetGmailIds.has(e.gmail_id)))
    setAnalyzedEmails(prev => {
      const next = prev.filter(e => !(e.classification === 'FAIBLE'))
      inboxCache.analyzedEmails = next
      return next
    })
    try {
      const res = await apiPost<{ success: boolean; updated?: number }>(
        '/bulk-action',
        { action: 'mark-read', classification: 'FAIBLE' },
      )
      setPollResult(`${res.updated ?? 0} email(s) Faible marqué(s) comme lu(s)`)
      setTimeout(() => setPollResult(null), 4000)
    } catch (err) {
      setPollResult(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
      setTimeout(() => setPollResult(null), 4000)
      // Re-fetch pour revert l'optimiste si échec
      refreshAll()
    }
    setReadingFaible(false)
  }

  const handlePoll = async () => {
    setPolling(true)
    setPollResult(null)
    setPollProgress(null)
    try {
      await syncRead()
      let totalProcessed = 0
      let remaining = 1
      while (remaining > 0) {
        const res = await apiFetch('/manual-poll')
        const text = await res.text()
        let data: any
        try { data = JSON.parse(text) } catch { data = null }
        if (!res.ok || !data?.success) {
          setPollResult(`Erreur ${res.status}${data?.error ? ` : ${data.error}` : ''}`)
          break
        }
        totalProcessed += data.processed ?? 0
        remaining = data.remaining ?? 0
        if (remaining > 0) {
          setPollProgress({ done: totalProcessed, total: totalProcessed + remaining })
          fetchInbox()
          fetchAnalyzed()
        }
      }
      await refreshAll()
      setPollResult(totalProcessed > 0 ? `${totalProcessed} email(s) traité(s)` : 'Aucun nouveau mail')
    } catch {
      setPollResult(`Erreur réseau`)
    }
    setPolling(false)
    setPollProgress(null)
    setTimeout(() => setPollResult(null), 8000)
  }

  const openUsage = async () => {
    setUsageOpen(true)
    setUsageLoading(true)
    try {
      const res = await apiFetch('/usage')
      const text = await res.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        throw new Error(`Réponse non-JSON (${res.status}): ${text.slice(0, 200)}`)
      }
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setUsageData(data)
    } catch (err: any) {
      setUsageData({ error: `Erreur de chargement : ${err?.message ?? err}` })
    }
    setUsageLoading(false)
  }

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-[#E8452A] border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-4.5rem)] flex gap-3">

      {/* ── Sidebar collapsée (juste les dots) quand un email est ouvert ── */}
      {selectedEmail && (
        <aside className="w-12 flex-shrink-0 flex flex-col items-center gap-2 pt-1">
          {FILTERS.map(f => {
            const active = filter === f.key
            const count = counts[f.key]
            const showCount = f.key !== 'all' && f.key !== 'unanalyzed' && count > 0
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                title={showCount ? `${f.label} (${count})` : f.label}
                className={`relative w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                  active ? 'ring-2 ring-[#F0024F] ring-offset-2 ring-offset-[#F5F0EA]' : 'hover:bg-[#F0EDE8]'
                }`}
              >
                {f.dot ? (
                  <span className={`w-3 h-3 rounded-full ${f.dot}`} />
                ) : (
                  <span className="text-[10px] font-bold text-[#555]">All</span>
                )}
                {showCount && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-[#1a1a1a] text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            )
          })}
          <div className="w-6 h-px bg-[#D8D0C5] my-1" />
          <button
            onClick={() => setComposing(true)}
            title="Nouveau mail"
            className="w-9 h-9 rounded-full border border-[#F0024F] text-[#F0024F] hover:bg-[#FEE9E5] transition-colors flex items-center justify-center"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            onClick={handlePoll}
            disabled={polling}
            title="Analyser tous les non lus"
            className="w-9 h-9 rounded-full bg-[#F0024F] text-white hover:bg-[#d00245] disabled:opacity-40 transition-colors flex items-center justify-center"
          >
            <svg className={`w-4 h-4 ${polling ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </aside>
      )}

      {/* ── Sidebar gauche (large) : filtres + boutons quand aucun email ouvert ── */}
      <aside className={`w-56 flex-shrink-0 flex-col gap-1.5 ${selectedEmail ? 'hidden' : 'flex'}`}>
        <div className="text-[10px] uppercase tracking-widest font-bold text-[#aaa] px-2 mb-1">
          Filtres
        </div>
        {FILTERS.map(f => {
          const active = filter === f.key
          const count = counts[f.key]
          const showCount = f.key !== 'all' && f.key !== 'unanalyzed'
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-sm transition-colors ${
                active
                  ? 'bg-[#F0024F] text-white font-semibold shadow-sm'
                  : 'text-[#555] hover:bg-[#F0EDE8]'
              }`}
            >
              <span className="flex items-center gap-2">
                {f.dot && <span className={`w-2.5 h-2.5 rounded-full ${f.dot}`} />}
                {f.label}
              </span>
              {showCount && (
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                  active ? 'bg-white/30 text-white' : 'bg-[#EDE8E0] text-[#888]'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}

        <div className="mt-6 px-2 flex flex-col gap-2">
          <button
            onClick={() => setComposing(true)}
            className="w-full px-3 py-2 rounded-xl font-semibold text-[#F0024F] border border-[#F0024F] hover:bg-[#FEE9E5] transition-colors text-sm shadow-sm"
          >
            Nouveau mail
          </button>
          <button
            onClick={handlePoll}
            disabled={polling}
            className="w-full px-3 py-2 rounded-xl font-semibold text-white bg-[#F0024F] hover:bg-[#d00245] transition-colors disabled:opacity-40 text-sm shadow-sm"
          >
            {polling ? (
              <span className="flex items-center justify-center gap-1.5">
                <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                Analyse en cours...
              </span>
            ) : 'Analyser tous les non lus'}
          </button>
          {counts.FAIBLE > 0 && (
            <button
              onClick={handleReadFaible}
              disabled={readingFaible}
              className="w-full px-3 py-2 rounded-xl font-medium text-[#888] border border-[#D8D0C5] hover:text-[#E8452A] hover:border-[#E8452A] hover:bg-[#FEE9E5] transition-colors disabled:opacity-40 text-[12px] flex items-center justify-center gap-1.5"
              title="Marquer tous les emails Faible comme lus"
            >
              {readingFaible ? (
                <>
                  <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full" />
                  Lecture...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l9 6 9-6M3 8v10a2 2 0 002 2h14a2 2 0 002-2V8M3 8l9-5 9 5" />
                  </svg>
                  Read Faible ({counts.FAIBLE})
                </>
              )}
            </button>
          )}
        </div>

        {(polling && pollProgress) && (
          <p className="text-[11px] text-[#555] text-center mt-2">
            Traitement {pollProgress.done} / {pollProgress.total}...
          </p>
        )}
        {pollResult && !polling && (
          <p className={`text-[11px] text-center mt-2 px-2 py-1 rounded-full ${
            pollResult.startsWith('Erreur') ? 'bg-[#FEE9E5] text-[#C23B2A]' : 'bg-[#EDE8E0] text-[#555]'
          }`}>
            {pollResult}
          </p>
        )}

        <div className="mt-auto px-2 text-[11px] text-[#aaa] space-y-1">
          {unreadCount !== null && unreadCount > 0 && (
            <p>{unreadCount} non lu{unreadCount > 1 ? 's' : ''} dans Gmail</p>
          )}
          {draftCount > 0 && (
            <p>{draftCount} brouillon{draftCount > 1 ? 's' : ''} à envoyer</p>
          )}
          <p>Maj {lastRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>
          <div className="flex gap-2">
            <button onClick={refreshAll} className="hover:text-[#E8452A] transition-colors underline underline-offset-2">
              Actualiser
            </button>
            <button onClick={openUsage} className="hover:text-[#E8452A] transition-colors underline underline-offset-2">
              Usage
            </button>
          </div>
        </div>
      </aside>

      {/* ── Zone principale : [liste] [email | brouillon] ── */}
      <main className="flex-1 min-w-0 bg-white border border-[#EDE8E0] rounded-2xl overflow-hidden flex">
        {/* Liste (rétrécit quand un email est ouvert) */}
        <div
          className={`overflow-y-auto border-r border-[#EDE8E0] ${selectedEmail ? 'shrink-0 basis-[317px] grow-[317] min-w-[280px]' : 'flex-1'}`}
        >
          <EmailList
            emails={filteredEmails}
            loading={loading || loadingMore}
            onSelect={handleSelect}
            onLoadMore={handleLoadMore}
            hasMore={filter === 'all' && !!nextPageToken}
            onToggleRead={handleToggleRead}
          />
        </div>

        {/* EmailDetail inline (uniquement quand un email est sélectionné) */}
        {selectedEmail && (
          <ModalErrorBoundary onClose={handleClose}>
            <EmailDetail
              email={selectedEmail}
              onClose={handleClose}
              onAction={handleAction}
              onRefresh={refreshAll}
              analyzing={analyzing}
              onAnalyze={selectedEmail.id.startsWith('tmp-') ? runAnalysis : undefined}
              onForward={handleForward}
              inline
            />
          </ModalErrorBoundary>
        )}
      </main>

      {/* ── Modal compose ── */}
      {composing && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) { setComposing(false); setForwardPrefill(null) } }}
        >
          <div className="w-full max-w-2xl min-h-[50vh] max-h-[90vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl">
            <ComposeEmail
              onClose={() => { setComposing(false); setForwardPrefill(null) }}
              onSent={() => { setComposing(false); setForwardPrefill(null); refreshAll() }}
              initialSubject={forwardPrefill?.subject}
              initialBody={forwardPrefill?.body}
            />
          </div>
        </div>,
        document.body,
      )}

      {/* ── Modal Usage ── */}
      {usageOpen && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setUsageOpen(false) }}
        >
          <div className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#EDE8E0]">
              <h2 className="text-lg font-semibold text-[#1a1a1a]">Usage Claude — Coût du bot</h2>
              <button onClick={() => setUsageOpen(false)} className="text-[#999] hover:text-[#1a1a1a] text-xl leading-none">×</button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {usageLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin h-6 w-6 border-2 border-[#E8452A] border-t-transparent rounded-full" />
                </div>
              ) : usageData?.error ? (
                <p className="text-red-600 text-sm">{usageData.error}</p>
              ) : usageData?.summary ? (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="bg-[#F5F0EA] rounded-xl p-4">
                      <p className="text-xs text-[#999] uppercase tracking-wider mb-1">Coût total</p>
                      <p className="text-2xl font-bold text-[#1a1a1a]">${usageData.summary.total_cost.toFixed(4)}</p>
                    </div>
                    <div className="bg-[#F5F0EA] rounded-xl p-4">
                      <p className="text-xs text-[#999] uppercase tracking-wider mb-1">Coût moyen / mail</p>
                      <p className="text-2xl font-bold text-[#1a1a1a]">${usageData.summary.avg_cost_per_email.toFixed(5)}</p>
                      <p className="text-[10px] text-[#999] mt-1">sur {usageData.summary.emails_processed} mail{usageData.summary.emails_processed > 1 ? 's' : ''}</p>
                    </div>
                    <div className="bg-[#F5F0EA] rounded-xl p-4">
                      <p className="text-xs text-[#999] uppercase tracking-wider mb-1">Appels totaux</p>
                      <p className="text-2xl font-bold text-[#1a1a1a]">{usageData.summary.total_calls}</p>
                      <p className="text-[10px] text-[#999] mt-1">{usageData.summary.total_input.toLocaleString()} in / {usageData.summary.total_output.toLocaleString()} out</p>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

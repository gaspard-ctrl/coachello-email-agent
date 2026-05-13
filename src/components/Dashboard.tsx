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

type Filter = 'all' | 'unread' | Classification | 'unanalyzed' | 'sent'

const FILTERS: { key: Filter; label: string; dot?: string }[] = [
  { key: 'all',         label: 'Tous' },
  { key: 'unread',      label: 'Non lues',  dot: 'bg-[#1a1a1a]' },
  { key: 'URGENT',      label: 'Urgent',    dot: 'bg-[#F0024F]' },
  { key: 'IMPORTANT',   label: 'Important', dot: 'bg-[#F768A8]' },
  { key: 'NORMAL',      label: 'Normal',    dot: 'bg-[#FBBED7]' },
  { key: 'FAIBLE',      label: 'Faible',    dot: 'bg-[#FDE8F2] border border-[#C8A0BE]' },
  { key: 'unanalyzed',  label: 'Non analysé', dot: 'bg-[#EDE8E0] border border-[#D8D0C5]' },
  { key: 'sent',        label: 'Envoyés',   dot: 'bg-[#D8E0D5] border border-[#9BB59F]' },
]

export default function Dashboard() {
  // Inbox Gmail (toutes les lignes — analysées ou non)
  const [gmailEmails, setGmailEmails] = useState<GmailEmail[]>(inboxCache.gmailEmails ?? [])
  const [analyzedEmails, setAnalyzedEmails] = useState<Email[]>(inboxCache.analyzedEmails ?? [])
  const [sentEmails, setSentEmails] = useState<GmailEmail[]>(inboxCache.sentEmails ?? [])
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

  // Recherche Gmail (transverse à toutes les pages — utilise q côté Gmail API)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  // ─────────────────────────────────────────────────────────────
  // Fetch helpers
  // ─────────────────────────────────────────────────────────────
  const fetchInbox = useCallback(async () => {
    try {
      const qs = search ? `&search=${encodeURIComponent(search)}` : ''
      const data = await apiGet<{ emails: GmailEmail[]; nextPageToken: string | null }>(`/gmail-inbox?folder=inbox&limit=50${qs}`)
      setGmailEmails(data.emails)
      setNextPageToken(data.nextPageToken)
      // Le cache n'est pertinent que pour l'inbox normale (pas de recherche active)
      if (!search) {
        inboxCache.gmailEmails = data.emails
        inboxCache.nextPageToken = data.nextPageToken
      }
      setLastRefresh(new Date())
    } catch (err) {
      console.error('Erreur fetchInbox:', err)
    } finally {
      setLoading(false)
    }
  }, [search])

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

  const fetchSent = useCallback(async () => {
    try {
      const data = await apiGet<{ emails: GmailEmail[] }>('/gmail-inbox?folder=sent&limit=50')
      const emails = data.emails ?? []
      setSentEmails(emails)
      inboxCache.sentEmails = emails
    } catch (err) {
      console.error('Erreur fetchSent:', err)
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
    await Promise.all([fetchInbox(), fetchAnalyzed(), fetchSent()])
    fetchCounts()
  }, [fetchInbox, fetchAnalyzed, fetchSent, fetchCounts, syncRead])

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
    // Tous les compteurs comptent des THREADS uniques (pas des messages),
    // et chaque compteur reflète exactement la liste affichée quand on clique
    // sur le filtre correspondant.
    const c: Record<Filter, number> = { all: 0, unread: 0, URGENT: 0, IMPORTANT: 0, NORMAL: 0, FAIBLE: 0, unanalyzed: 0, sent: 0 }

    // Classifications → uniquement les emails analysés ET non-lus dans Gmail.
    // Source : enrichedInbox (qui contient l'état is_unread à jour depuis Gmail).
    // Les emails analysés mais déjà lus disparaissent des catégories.
    const threadsByClass: Record<Classification, Set<string>> = {
      URGENT: new Set(), IMPORTANT: new Set(), NORMAL: new Set(), FAIBLE: new Set(),
    }
    for (const e of enrichedInbox) {
      if (!e.is_analyzed || !e.is_unread || !e.classification) continue
      const tid = e.thread_id || e.gmail_id
      threadsByClass[e.classification].add(tid)
    }
    c.URGENT = threadsByClass.URGENT.size
    c.IMPORTANT = threadsByClass.IMPORTANT.size
    c.NORMAL = threadsByClass.NORMAL.size
    c.FAIBLE = threadsByClass.FAIBLE.size

    // all / unread / unanalyzed → source = page Gmail courante (enrichedInbox).
    const allThreads = new Set<string>()
    const unreadThreads = new Set<string>()
    const unanalyzedThreads = new Set<string>()
    for (const e of enrichedInbox) {
      const tid = e.thread_id || e.gmail_id
      allThreads.add(tid)
      if (e.is_unread) unreadThreads.add(tid)
      if (!e.is_analyzed) unanalyzedThreads.add(tid)
    }
    c.all = allThreads.size
    c.unread = unreadThreads.size
    c.unanalyzed = unanalyzedThreads.size

    // Envoyés → threads uniques dans la liste sent
    const sentThreads = new Set<string>()
    for (const e of sentEmails) sentThreads.add(e.thread_id || e.gmail_id)
    c.sent = sentThreads.size

    return c
  }, [enrichedInbox, analyzedEmails, sentEmails])

  const filteredEmails = useMemo(() => {
    let list: GmailEmail[]
    if (filter === 'all') {
      // Page Gmail courante uniquement
      list = enrichedInbox
    } else if (filter === 'unread') {
      // Page Gmail courante uniquement (non-lues)
      list = enrichedInbox.filter(e => e.is_unread)
    } else if (filter === 'unanalyzed') {
      // Page Gmail courante uniquement (non-analysés)
      list = enrichedInbox.filter(e => !e.is_analyzed)
    } else if (filter === 'sent') {
      // Derniers envois Gmail
      list = sentEmails
    } else {
      // Filtre par classification → uniquement les emails analysés ET non-lus
      // dans la page Gmail courante. Les emails analysés déjà lus n'apparaissent
      // plus dans leur catégorie (cohérent avec les compteurs).
      list = enrichedInbox.filter(e => e.is_analyzed && e.is_unread && e.classification === filter)
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
  }, [enrichedInbox, sentEmails, analyzedEmails, filter])

  // ─────────────────────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────────────────────
  const handleSelect = (g: GmailEmail) => {
    setAnalyzing(false)
    // Cas 0 : email envoyé → on l'ouvre directement dans Gmail (lecture seule)
    if (g.folder === 'sent') {
      const tid = g.thread_id || g.gmail_id
      window.open(`https://mail.google.com/mail/u/0/#sent/${tid}`, '_blank', 'noopener')
      return
    }
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

  const runAnalysis = async (context?: string) => {
    if (!selectedEmail) return
    setAnalyzing(true)
    try {
      const res = await apiPost<{ success: boolean; email?: Email; skipped?: boolean; reason?: string }>(
        '/analyze-email',
        {
          gmail_id: selectedEmail.gmail_id,
          thread_id: selectedEmail.thread_id,
          ...(context && context.trim() ? { context: context.trim() } : {}),
        },
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
      await apiPost('/mark-read', { gmail_id: gmailId, thread_id: threadId, unread: newUnread })
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
      const qs = search ? `&search=${encodeURIComponent(search)}` : ''
      const data = await apiGet<{ emails: GmailEmail[]; nextPageToken: string | null }>(
        `/gmail-inbox?folder=inbox&limit=50&pageToken=${encodeURIComponent(nextPageToken)}${qs}`,
      )
      const next = [...gmailEmails, ...data.emails]
      setGmailEmails(next)
      setNextPageToken(data.nextPageToken)
      if (!search) {
        inboxCache.gmailEmails = next
        inboxCache.nextPageToken = data.nextPageToken
      }
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
            const showCount = f.key !== 'all' && f.key !== 'unanalyzed' && f.key !== 'sent' && count > 0
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
          const showCount = f.key !== 'all' && f.key !== 'unanalyzed' && f.key !== 'sent'
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
          className={`flex flex-col border-r border-[#EDE8E0] ${selectedEmail ? 'shrink-0 basis-[317px] grow-[317] min-w-[280px]' : 'flex-1'}`}
        >
          {/* Barre de recherche Gmail (transverse à toutes les pages) */}
          <div className="flex-shrink-0 px-3 py-2 border-b border-[#EDE8E0] bg-white">
            <form
              onSubmit={e => { e.preventDefault(); setSearch(searchInput.trim()) }}
              className="flex items-center gap-1.5 bg-[#F5F0EA] rounded-full px-3 py-1.5 focus-within:bg-white focus-within:ring-2 focus-within:ring-[#E8452A]"
            >
              <svg className="w-4 h-4 text-[#888] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Rechercher dans Gmail (toutes les pages)..."
                className="flex-1 min-w-0 bg-transparent text-[13px] focus:outline-none placeholder:text-[#aaa]"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => { setSearchInput(''); setSearch('') }}
                  className="text-[#aaa] hover:text-[#E8452A] flex-shrink-0 p-0.5"
                  title="Effacer la recherche"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </form>
            {search && (
              <p className="text-[10.5px] text-[#888] mt-1 px-2">
                Recherche : « <span className="font-medium text-[#555]">{search}</span> » — résultats sur l'ensemble de Gmail
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            <EmailList
              emails={filteredEmails}
              loading={loading || loadingMore}
              onSelect={handleSelect}
              onLoadMore={handleLoadMore}
              hasMore={(filter === 'all' || !!search) && !!nextPageToken}
              onToggleRead={handleToggleRead}
            />
          </div>
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
        <UsageModal
          data={usageData}
          loading={usageLoading}
          onClose={() => setUsageOpen(false)}
          onRefresh={openUsage}
        />,
        document.body,
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Modal Usage : vue complète des coûts Claude
// ─────────────────────────────────────────────────────────────
type UsageTab = 'overview' | 'functions' | 'logs'

function UsageModal({
  data,
  loading,
  onClose,
  onRefresh,
}: {
  data: any
  loading: boolean
  onClose: () => void
  onRefresh: () => void
}) {
  const [tab, setTab] = useState<UsageTab>('overview')
  const [logFilter, setLogFilter] = useState<string>('all')

  const fmtUsd = (n: number, digits = 4) =>
    `$${(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  const fmtInt = (n: number) => (n ?? 0).toLocaleString('fr-FR')
  const fmtDate = (s?: string) => {
    if (!s) return '—'
    const d = new Date(s)
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  const filteredLog = useMemo(() => {
    const log: any[] = data?.log ?? []
    return logFilter === 'all' ? log : log.filter(l => l.function_name === logFilter)
  }, [data?.log, logFilter])

  const functionNames: string[] = useMemo(() => {
    const log: any[] = data?.log ?? []
    const set = new Set<string>()
    log.forEach(l => set.add(l.function_name))
    return Array.from(set).sort()
  }, [data?.log])

  const maxDayCost = useMemo(() => {
    const days: any[] = data?.by_day ?? []
    return days.reduce((m, d) => Math.max(m, d.cost ?? 0), 0)
  }, [data?.by_day])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-6xl max-h-[92vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#EDE8E0]">
          <div>
            <h2 className="text-lg font-semibold text-[#1a1a1a]">Usage Claude — Coût du bot</h2>
            {data?.summary?.last_call_at && (
              <p className="text-[11px] text-[#999] mt-0.5">
                Dernier appel : {fmtDate(data.summary.last_call_at)}
                {data.summary.first_call_at && ` · Premier appel : ${fmtDate(data.summary.first_call_at)}`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              disabled={loading}
              className="text-[12px] px-3 py-1.5 rounded-lg border border-[#EDE8E0] text-[#555] hover:bg-[#F5F0EA] disabled:opacity-40 transition-colors"
            >
              {loading ? 'Chargement…' : 'Actualiser'}
            </button>
            <button onClick={onClose} className="text-[#999] hover:text-[#1a1a1a] text-2xl leading-none px-2">×</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-3 border-b border-[#EDE8E0] bg-[#FAF7F2]">
          {([
            { k: 'overview',  l: 'Vue d\'ensemble' },
            { k: 'functions', l: 'Par fonction / modèle' },
            { k: 'logs',      l: `Logs détaillés${data?.log ? ` (${data.log.length})` : ''}` },
          ] as Array<{k: UsageTab; l: string}>).map(t => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                tab === t.k
                  ? 'bg-white text-[#1a1a1a] border border-b-white border-[#EDE8E0] -mb-px'
                  : 'text-[#888] hover:text-[#1a1a1a]'
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading && !data ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin h-6 w-6 border-2 border-[#E8452A] border-t-transparent rounded-full" />
            </div>
          ) : data?.error ? (
            <p className="text-red-600 text-sm">{data.error}</p>
          ) : !data?.summary ? (
            <p className="text-[#888] text-sm">Aucune donnée disponible.</p>
          ) : (
            <>
              {/* ── TAB : Vue d'ensemble ── */}
              {tab === 'overview' && (
                <>
                  {/* Cartes principales */}
                  <div className="grid grid-cols-4 gap-3">
                    <StatCard label="Coût total" value={fmtUsd(data.summary.total_cost)} sub={`${fmtInt(data.summary.total_calls)} appels`} />
                    <StatCard label="Coût / mail traité" value={fmtUsd(data.summary.avg_cost_per_email, 5)} sub={`sur ${fmtInt(data.summary.emails_processed)} mail${data.summary.emails_processed > 1 ? 's' : ''}`} />
                    <StatCard label="Coût / appel" value={fmtUsd(data.summary.avg_cost_per_call, 5)} sub="tous appels confondus" />
                    <StatCard label="Classify (mail)" value={fmtUsd(data.summary.classify_cost)} sub="part la plus chère" highlight />
                  </div>

                  {/* Fenêtres temporelles */}
                  <div className="grid grid-cols-3 gap-3">
                    <StatCard label="24 dernières heures" value={fmtUsd(data.summary.cost_24h)} sub={`${fmtInt(data.summary.calls_24h)} appel${data.summary.calls_24h > 1 ? 's' : ''}`} compact />
                    <StatCard label="7 derniers jours"    value={fmtUsd(data.summary.cost_7d)}  sub={`${fmtInt(data.summary.calls_7d)} appel${data.summary.calls_7d > 1 ? 's' : ''}`}  compact />
                    <StatCard label="30 derniers jours"   value={fmtUsd(data.summary.cost_30d)} sub={`${fmtInt(data.summary.calls_30d)} appel${data.summary.calls_30d > 1 ? 's' : ''}`} compact />
                  </div>

                  {/* Tokens */}
                  <section>
                    <h3 className="text-xs uppercase tracking-widest text-[#888] font-bold mb-2">Tokens consommés</h3>
                    <div className="grid grid-cols-4 gap-3">
                      <TokenCard label="Input"            value={data.summary.total_input} accent="#1a1a1a" />
                      <TokenCard label="Output"           value={data.summary.total_output} accent="#E8452A" />
                      <TokenCard label="Cache read"       value={data.summary.total_cache_read} accent="#F768A8" />
                      <TokenCard label="Cache creation"   value={data.summary.total_cache_creation} accent="#FBBED7" />
                    </div>
                  </section>

                  {/* Tarifs */}
                  {data.pricing && (
                    <section>
                      <h3 className="text-xs uppercase tracking-widest text-[#888] font-bold mb-2">Tarifs Anthropic (USD / 1M tokens)</h3>
                      <div className="bg-[#F5F0EA] rounded-xl overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-[#EDE8E0] text-[#666]">
                            <tr>
                              <th className="text-left px-4 py-2 font-medium">Modèle</th>
                              <th className="text-right px-4 py-2 font-medium">Input</th>
                              <th className="text-right px-4 py-2 font-medium">Output</th>
                              <th className="text-right px-4 py-2 font-medium">Cache read (×0,1)</th>
                              <th className="text-right px-4 py-2 font-medium">Cache write (×1,25)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(data.pricing).map(([m, p]: any) => (
                              <tr key={m} className="border-t border-[#E5DDD0]">
                                <td className="px-4 py-2 font-mono text-[12px]">{m}</td>
                                <td className="text-right px-4 py-2">{fmtUsd(p.input, 2)}</td>
                                <td className="text-right px-4 py-2">{fmtUsd(p.output, 2)}</td>
                                <td className="text-right px-4 py-2 text-[#888]">{fmtUsd(p.input * 0.1, 2)}</td>
                                <td className="text-right px-4 py-2 text-[#888]">{fmtUsd(p.input * 1.25, 2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}

                  {/* Timeline 30 jours */}
                  {Array.isArray(data.by_day) && data.by_day.length > 0 && (
                    <section>
                      <h3 className="text-xs uppercase tracking-widest text-[#888] font-bold mb-2">30 derniers jours</h3>
                      <div className="bg-[#F5F0EA] rounded-xl p-4">
                        <div className="flex items-end gap-1 h-32">
                          {data.by_day.map((d: any) => {
                            const pct = maxDayCost > 0 ? (d.cost / maxDayCost) * 100 : 0
                            return (
                              <div
                                key={d.day}
                                className="flex-1 group relative flex flex-col items-center justify-end min-w-0"
                                title={`${d.day} · ${fmtUsd(d.cost)} · ${d.calls} appels`}
                              >
                                <div
                                  className="w-full bg-[#E8452A] hover:bg-[#F0024F] transition-colors rounded-t"
                                  style={{ height: `${Math.max(pct, 2)}%` }}
                                />
                                <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:block bg-[#1a1a1a] text-white text-[10px] px-2 py-1 rounded whitespace-nowrap z-10">
                                  {d.day} · {fmtUsd(d.cost)} · {d.calls}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        <div className="flex justify-between text-[10px] text-[#999] mt-2">
                          <span>{data.by_day[0]?.day}</span>
                          <span>{data.by_day[data.by_day.length - 1]?.day}</span>
                        </div>
                      </div>
                    </section>
                  )}
                </>
              )}

              {/* ── TAB : Par fonction / modèle ── */}
              {tab === 'functions' && (
                <>
                  <section>
                    <h3 className="text-xs uppercase tracking-widest text-[#888] font-bold mb-2">Par fonction × modèle</h3>
                    <div className="overflow-x-auto rounded-xl border border-[#EDE8E0]">
                      <table className="w-full text-sm">
                        <thead className="bg-[#F5F0EA] text-[#666]">
                          <tr>
                            <th className="text-left px-4 py-2 font-medium">Fonction</th>
                            <th className="text-left px-4 py-2 font-medium">Modèle</th>
                            <th className="text-right px-4 py-2 font-medium">Appels</th>
                            <th className="text-right px-4 py-2 font-medium">Input</th>
                            <th className="text-right px-4 py-2 font-medium">Output</th>
                            <th className="text-right px-4 py-2 font-medium">Cache R/W</th>
                            <th className="text-right px-4 py-2 font-medium">Coût</th>
                            <th className="text-right px-4 py-2 font-medium">$/appel</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(data.by_function ?? []).map((row: any, i: number) => (
                            <tr key={i} className="border-t border-[#EDE8E0] hover:bg-[#FAF7F2]">
                              <td className="px-4 py-2 font-mono text-[12px] text-[#1a1a1a]">{row.function_name}</td>
                              <td className="px-4 py-2 font-mono text-[11px] text-[#666]">{row.model}</td>
                              <td className="text-right px-4 py-2">{fmtInt(row.calls)}</td>
                              <td className="text-right px-4 py-2 text-[#666]">{fmtInt(row.input_tokens)}</td>
                              <td className="text-right px-4 py-2 text-[#666]">{fmtInt(row.output_tokens)}</td>
                              <td className="text-right px-4 py-2 text-[#999] text-[12px]">
                                {fmtInt(row.cache_read_tokens)} / {fmtInt(row.cache_creation_tokens)}
                              </td>
                              <td className="text-right px-4 py-2 font-semibold">{fmtUsd(row.cost)}</td>
                              <td className="text-right px-4 py-2 text-[#666] text-[12px]">
                                {row.calls > 0 ? fmtUsd(row.cost / row.calls, 5) : '—'}
                              </td>
                            </tr>
                          ))}
                          {(data.by_function ?? []).length === 0 && (
                            <tr><td colSpan={8} className="text-center px-4 py-6 text-[#888]">Aucun appel enregistré.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-xs uppercase tracking-widest text-[#888] font-bold mb-2">Par modèle</h3>
                    <div className="overflow-x-auto rounded-xl border border-[#EDE8E0]">
                      <table className="w-full text-sm">
                        <thead className="bg-[#F5F0EA] text-[#666]">
                          <tr>
                            <th className="text-left px-4 py-2 font-medium">Modèle</th>
                            <th className="text-right px-4 py-2 font-medium">Appels</th>
                            <th className="text-right px-4 py-2 font-medium">Input</th>
                            <th className="text-right px-4 py-2 font-medium">Output</th>
                            <th className="text-right px-4 py-2 font-medium">Cache R/W</th>
                            <th className="text-right px-4 py-2 font-medium">Coût</th>
                            <th className="text-right px-4 py-2 font-medium">% du total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(data.by_model ?? []).map((row: any, i: number) => {
                            const pct = data.summary.total_cost > 0 ? (row.cost / data.summary.total_cost) * 100 : 0
                            return (
                              <tr key={i} className="border-t border-[#EDE8E0] hover:bg-[#FAF7F2]">
                                <td className="px-4 py-2 font-mono text-[12px]">{row.model}</td>
                                <td className="text-right px-4 py-2">{fmtInt(row.calls)}</td>
                                <td className="text-right px-4 py-2 text-[#666]">{fmtInt(row.input_tokens)}</td>
                                <td className="text-right px-4 py-2 text-[#666]">{fmtInt(row.output_tokens)}</td>
                                <td className="text-right px-4 py-2 text-[#999] text-[12px]">
                                  {fmtInt(row.cache_read_tokens)} / {fmtInt(row.cache_creation_tokens)}
                                </td>
                                <td className="text-right px-4 py-2 font-semibold">{fmtUsd(row.cost)}</td>
                                <td className="text-right px-4 py-2 text-[#666]">{pct.toFixed(1)}%</td>
                              </tr>
                            )
                          })}
                          {(data.by_model ?? []).length === 0 && (
                            <tr><td colSpan={7} className="text-center px-4 py-6 text-[#888]">Aucun appel enregistré.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </>
              )}

              {/* ── TAB : Logs ── */}
              {tab === 'logs' && (
                <section className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs uppercase tracking-widest text-[#888] font-bold">Filtre fonction</span>
                    <button
                      onClick={() => setLogFilter('all')}
                      className={`text-[12px] px-2.5 py-1 rounded-full transition-colors ${
                        logFilter === 'all' ? 'bg-[#1a1a1a] text-white' : 'bg-[#F5F0EA] text-[#555] hover:bg-[#EDE8E0]'
                      }`}
                    >
                      Toutes ({data.log?.length ?? 0})
                    </button>
                    {functionNames.map(name => {
                      const count = (data.log ?? []).filter((l: any) => l.function_name === name).length
                      return (
                        <button
                          key={name}
                          onClick={() => setLogFilter(name)}
                          className={`text-[12px] px-2.5 py-1 rounded-full transition-colors ${
                            logFilter === name ? 'bg-[#1a1a1a] text-white' : 'bg-[#F5F0EA] text-[#555] hover:bg-[#EDE8E0]'
                          }`}
                        >
                          {name} ({count})
                        </button>
                      )
                    })}
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-[#EDE8E0]">
                    <table className="w-full text-[12px]">
                      <thead className="bg-[#F5F0EA] text-[#666] sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Date</th>
                          <th className="text-left px-3 py-2 font-medium">Fonction</th>
                          <th className="text-left px-3 py-2 font-medium">Modèle</th>
                          <th className="text-right px-3 py-2 font-medium">In</th>
                          <th className="text-right px-3 py-2 font-medium">Out</th>
                          <th className="text-right px-3 py-2 font-medium">Cache R</th>
                          <th className="text-right px-3 py-2 font-medium">Cache W</th>
                          <th className="text-right px-3 py-2 font-medium">Coût</th>
                          <th className="text-left px-3 py-2 font-medium">Sujet</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredLog.map((row: any) => (
                          <tr key={row.id} className="border-t border-[#EDE8E0] hover:bg-[#FAF7F2]">
                            <td className="px-3 py-1.5 whitespace-nowrap text-[#666]">{fmtDate(row.created_at)}</td>
                            <td className="px-3 py-1.5 font-mono text-[11px]">{row.function_name}</td>
                            <td className="px-3 py-1.5 font-mono text-[11px] text-[#888]">
                              {row.model?.replace('claude-', '').replace('-20251001', '')}
                            </td>
                            <td className="text-right px-3 py-1.5 text-[#666]">{fmtInt(row.input_tokens)}</td>
                            <td className="text-right px-3 py-1.5 text-[#666]">{fmtInt(row.output_tokens)}</td>
                            <td className="text-right px-3 py-1.5 text-[#999]">{fmtInt(row.cache_read_tokens)}</td>
                            <td className="text-right px-3 py-1.5 text-[#999]">{fmtInt(row.cache_creation_tokens)}</td>
                            <td className="text-right px-3 py-1.5 font-semibold whitespace-nowrap">{fmtUsd(row.cost_usd, 5)}</td>
                            <td className="px-3 py-1.5 text-[#666] max-w-[260px] truncate" title={row.email_subject ?? ''}>
                              {row.email_subject ?? <span className="text-[#bbb]">—</span>}
                            </td>
                          </tr>
                        ))}
                        {filteredLog.length === 0 && (
                          <tr><td colSpan={9} className="text-center px-3 py-6 text-[#888]">Aucun appel.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <p className="text-[11px] text-[#999]">
                    {filteredLog.length} entrée{filteredLog.length > 1 ? 's' : ''} affichée{filteredLog.length > 1 ? 's' : ''} ·
                    coût cumulé : {fmtUsd(filteredLog.reduce((s: number, r: any) => s + (r.cost_usd ?? 0), 0), 5)}
                    {' · '}limite 500 entrées les plus récentes
                  </p>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({
  label, value, sub, highlight, compact,
}: { label: string; value: string; sub?: string; highlight?: boolean; compact?: boolean }) {
  return (
    <div className={`rounded-xl p-4 ${highlight ? 'bg-[#FEE9E5] border border-[#F0024F]/20' : 'bg-[#F5F0EA]'}`}>
      <p className="text-[10px] text-[#999] uppercase tracking-wider mb-1">{label}</p>
      <p className={`${compact ? 'text-xl' : 'text-2xl'} font-bold text-[#1a1a1a]`}>{value}</p>
      {sub && <p className="text-[10px] text-[#999] mt-1">{sub}</p>}
    </div>
  )
}

function TokenCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-xl p-3 bg-white border border-[#EDE8E0]">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full" style={{ background: accent }} />
        <p className="text-[10px] text-[#999] uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-lg font-bold text-[#1a1a1a]">{(value ?? 0).toLocaleString('fr-FR')}</p>
    </div>
  )
}

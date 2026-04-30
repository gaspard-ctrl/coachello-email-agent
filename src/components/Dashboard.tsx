import { useState, useEffect, useCallback, Component } from 'react'
import { createPortal } from 'react-dom'
import { Email, Classification, CLASSIFICATION_CONFIG } from '../types'
import EmailCard from './EmailCard'
import EmailDetail from './EmailDetail'
import ComposeEmail from './ComposeEmail'

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

const COLUMNS: Classification[] = ['URGENT', 'IMPORTANT', 'NORMAL', 'FAIBLE']

export default function Dashboard() {
  const [emails, setEmails]           = useState<Email[]>([])
  const [selectedEmail, setSelected]  = useState<Email | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [polling, setPolling]         = useState(false)
  const [pollResult, setPollResult]   = useState<string | null>(null)
  const [refreshed, setRefreshed]     = useState(false)
  const [pollProgress, setPollProgress] = useState<{ done: number; total: number } | null>(null)
  const [unreadCount, setUnreadCount] = useState<number | null>(null)
  const [markingAllRead, setMarkingAllRead] = useState(false)
  const [composing, setComposing] = useState(false)

  const [draftCount, setDraftCount] = useState(0)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageData, setUsageData] = useState<any>(null)
  const [usageLoading, setUsageLoading] = useState(false)

  const openUsage = async () => {
    setUsageOpen(true)
    setUsageLoading(true)
    try {
      const res = await fetch('/api/usage')
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

  const fetchEmails = useCallback(async () => {
    try {
      const res      = await fetch('/api/emails')
      const data     = await res.json()
      const newEmails: Email[] = Array.isArray(data.emails) ? data.emails : []
      setEmails(newEmails)
      setSelected(prev => prev ? (newEmails.find(e => e.id === prev.id) ?? prev) : null)
      setLastRefresh(new Date())
      setRefreshed(true)
      setTimeout(() => setRefreshed(false), 2000)
      // Compter les brouillons Gmail
      fetch('/api/manual-poll?drafts=true')
        .then(r => r.json())
        .then(d => { if (d.drafts !== undefined) setDraftCount(d.drafts) })
        .catch(() => {})
    } catch (err) {
      console.error('Erreur fetchEmails:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res  = await fetch('/api/manual-poll?count=true')
      const data = await res.json()
      if (data.count !== undefined) setUnreadCount(data.count)
    } catch {
      // silencieux
    }
  }, [])

  const syncRead = useCallback(async () => {
    await fetch('/api/sync-read').catch(() => {})
  }, [])

  useEffect(() => {
    fetchEmails()
    fetchUnreadCount()
    const interval = setInterval(() => {
      syncRead().then(() => fetchEmails())
      fetchUnreadCount()
    }, 2 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchEmails, fetchUnreadCount, syncRead])

  const handleOpen = (email: Email) => {
    setSelected(email)
  }

  const handleClose = () => {
    setSelected(null)
    fetchEmails()
  }

  const handlePoll = async () => {
    setPolling(true)
    setPollResult(null)
    setPollProgress(null)

    try {
      await syncRead()

      let totalProcessed = 0
      let remaining = 1 // démarre à 1 pour entrer dans la boucle

      while (remaining > 0) {
        const res  = await fetch('/api/manual-poll')
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
          fetchEmails()
        }
      }

      fetchEmails()
      setPollResult(totalProcessed > 0 ? `${totalProcessed} email(s) traité(s)` : 'Aucun nouveau mail')
    } catch {
      setPollResult(`Erreur réseau`)
    }

    setPolling(false)
    setPollProgress(null)
    fetchUnreadCount()
    setTimeout(() => setPollResult(null), 8000)
  }

  // Après valider/rejeter : fermer et rafraîchir
  const handleAction = () => {
    const emailId = selectedEmail?.id
    setSelected(null)
    // Retirer l'email immédiatement (optimiste) pour éviter qu'il reste affiché
    if (emailId) {
      setEmails(prev => prev.filter(e => e.id !== emailId))
    }
    fetchEmails()
    fetchUnreadCount()
  }

  const countForColumn = (classification: Classification) =>
    emails.filter(e => e.classification === classification).length

  const handleMarkAllRead = async (classification: Classification) => {
    setMarkingAllRead(true)
    try {
      await fetch('/api/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-read', classification }),
      })
      fetchEmails()
    } catch {
      // silencieux
    }
    setMarkingAllRead(false)
  }


  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-[#E8452A] border-t-transparent rounded-full" />
      </div>
    )
  }

  const COLUMN_STYLE: Record<string, { header: string; label: string; badge: string }> = {
    URGENT:    { header: 'bg-[#F0024F]', label: 'text-white font-bold',      badge: 'bg-white/30 text-white' },
    IMPORTANT: { header: 'bg-[#F768A8]', label: 'text-white font-bold',      badge: 'bg-white/30 text-white' },
    NORMAL:    { header: 'bg-[#FBBED7]', label: 'text-[#A5002E] font-bold',  badge: 'bg-white/50 text-[#A5002E]' },
    FAIBLE:    { header: 'bg-[#FDE8F2]', label: 'text-[#C8A0BE] font-bold',  badge: 'bg-white/50 text-[#C8A0BE]' },
  }

  return (
    <div className="h-[calc(100vh-8rem)]">

      {/* ── Colonnes du Kanban ── */}
      <div className="grid grid-cols-4 gap-4 h-full">
        {COLUMNS.map(classification => {
          const conf         = CLASSIFICATION_CONFIG[classification]
          const colStyle     = COLUMN_STYLE[classification]
          const columnEmails = emails.filter(e => e.classification === classification)

          return (
            <div key={classification} className="flex flex-col min-w-0 overflow-hidden">
              <div className={`flex items-center justify-between px-3 py-2.5 rounded-2xl mb-3 ${colStyle.header}`}>
                <span className={`text-xs uppercase tracking-wider whitespace-nowrap ${colStyle.label}`}>{conf.label}</span>
                <div className="flex items-center gap-2">
                  {classification === 'FAIBLE' && countForColumn('FAIBLE') > 0 && (
                    <button
                      onClick={() => handleMarkAllRead('FAIBLE')}
                      disabled={markingAllRead}
                      title="Tout marquer comme lu"
                      className="text-[10px] font-semibold text-[#C8A0BE] bg-white/50 hover:bg-white/80 px-2 py-0.5 rounded-full transition-colors disabled:opacity-40 whitespace-nowrap"
                    >
                      {markingAllRead ? '...' : 'Tout lire'}
                    </button>
                  )}
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${colStyle.badge}`}>
                    {countForColumn(classification)}
                  </span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {columnEmails.length === 0 ? (
                  <div className="text-center py-8 text-[#bbb] text-sm">
                    Aucun email en attente
                  </div>
                ) : (
                  columnEmails.map(email => (
                    <EmailCard
                      key={email.id}
                      email={email}
                      onOpen={handleOpen}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Modal email (Portal sur document.body pour éviter tout problème CSS) ── */}
      {selectedEmail && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) handleClose() }}
        >
          <div className="w-full max-w-7xl min-h-[70vh] max-h-[95vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl">
            <ModalErrorBoundary onClose={handleClose}>
              <EmailDetail
                email={selectedEmail}
                onClose={handleClose}
                onAction={handleAction}
                onRefresh={fetchEmails}
              />
            </ModalErrorBoundary>
          </div>
        </div>,
        document.body
      )}

      {/* ── Modal compose (Portal) ── */}
      {composing && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setComposing(false) }}
        >
          <div className="w-full max-w-2xl min-h-[50vh] max-h-[90vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl">
            <ComposeEmail
              onClose={() => setComposing(false)}
              onSent={() => { setComposing(false); fetchEmails() }}
            />
          </div>
        </div>,
        document.body
      )}

      {/* ── Barre du bas ── */}
      <div className="fixed bottom-4 left-0 right-0 flex flex-col items-center gap-2 text-xs text-[#aaa] px-6">

        {/* Boutons — centré */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setComposing(true)}
            className="px-4 py-2 rounded-xl font-semibold text-[#F0024F] border border-[#F0024F] hover:bg-[#FEE9E5] transition-colors text-sm shadow-sm"
          >
            Nouveau mail
          </button>
          <button
            onClick={handlePoll}
            disabled={polling}
            className="px-4 py-2 rounded-xl font-semibold text-white bg-[#F0024F] hover:bg-[#d00245] transition-colors disabled:opacity-40 text-sm shadow-sm"
          >
          {polling ? (
            <span className="flex items-center gap-1.5">
              <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
              Recherche...
            </span>
          ) : 'Chercher nouveaux emails'}
          </button>
        </div>

        {/* Badges et infos secondaires */}
        <div className="flex items-center justify-center gap-3">
          {/* Résultat / progression */}
          {polling && pollProgress ? (
            <span className="text-[#555] font-medium">
              Traitement {pollProgress.done} / {pollProgress.total}...
            </span>
          ) : pollResult ? (
            <span className={`px-2.5 py-1 rounded-full font-semibold ${
              pollResult.startsWith('Erreur') || pollResult.startsWith('Réseau')
                ? 'bg-[#FEE9E5] text-[#C23B2A]'
                : 'bg-[#EDE8E0] text-[#555]'
            }`}>
              {pollResult}
            </span>
          ) : null}

          {/* Badge brouillons à envoyer */}
          {draftCount > 0 && (
            <span className="bg-[#F768A8] text-white font-bold px-2.5 py-0.5 rounded-full">
              {draftCount} brouillon{draftCount > 1 ? 's' : ''} à envoyer
            </span>
          )}

          {/* Badge mails non lus */}
          {unreadCount !== null && unreadCount > 0 && (
            <span className="bg-[#E8452A] text-white font-bold px-2.5 py-0.5 rounded-full">
              {unreadCount} non lu{unreadCount > 1 ? 's' : ''}
            </span>
          )}

          <button
            onClick={fetchEmails}
            className="hover:text-[#E8452A] transition-colors underline underline-offset-2"
          >
            {refreshed ? 'Actualisé ✓' : 'Actualiser'}
          </button>
          <span>— {lastRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
          <button
            onClick={openUsage}
            className="hover:text-[#E8452A] transition-colors underline underline-offset-2"
          >
            Usage
          </button>
        </div>
      </div>

      {/* ── Modal Usage ── */}
      {usageOpen && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setUsageOpen(false) }}
        >
          <div className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#EDE8E0]">
              <h2 className="text-lg font-semibold text-[#1a1a1a]">Usage Claude — Coût du bot</h2>
              <button
                onClick={() => setUsageOpen(false)}
                className="text-[#999] hover:text-[#1a1a1a] text-xl leading-none"
              >
                ×
              </button>
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
                      <p className="text-2xl font-bold text-[#1a1a1a]">
                        ${usageData.summary.total_cost.toFixed(4)}
                      </p>
                    </div>
                    <div className="bg-[#F5F0EA] rounded-xl p-4">
                      <p className="text-xs text-[#999] uppercase tracking-wider mb-1">Coût moyen / mail</p>
                      <p className="text-2xl font-bold text-[#1a1a1a]">
                        ${usageData.summary.avg_cost_per_email.toFixed(5)}
                      </p>
                      <p className="text-[10px] text-[#999] mt-1">
                        sur {usageData.summary.emails_processed} mail{usageData.summary.emails_processed > 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="bg-[#F5F0EA] rounded-xl p-4">
                      <p className="text-xs text-[#999] uppercase tracking-wider mb-1">Appels totaux</p>
                      <p className="text-2xl font-bold text-[#1a1a1a]">
                        {usageData.summary.total_calls}
                      </p>
                      <p className="text-[10px] text-[#999] mt-1">
                        {usageData.summary.total_input.toLocaleString()} in / {usageData.summary.total_output.toLocaleString()} out
                      </p>
                    </div>
                  </div>

                  {usageData.by_function?.length > 0 && (
                    <div>
                      <h3 className="text-xs uppercase tracking-wider text-[#999] font-semibold mb-2">Par fonction</h3>
                      <div className="border border-[#EDE8E0] rounded-xl overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[#F5F0EA] text-[#666]">
                            <tr>
                              <th className="text-left px-3 py-2 font-semibold">Fonction</th>
                              <th className="text-left px-3 py-2 font-semibold">Modèle</th>
                              <th className="text-right px-3 py-2 font-semibold">Appels</th>
                              <th className="text-right px-3 py-2 font-semibold">In</th>
                              <th className="text-right px-3 py-2 font-semibold">Out</th>
                              <th className="text-right px-3 py-2 font-semibold">Coût</th>
                            </tr>
                          </thead>
                          <tbody>
                            {usageData.by_function.map((row: any, i: number) => (
                              <tr key={i} className="border-t border-[#EDE8E0]">
                                <td className="px-3 py-2 text-[#1a1a1a]">{row.function_name}</td>
                                <td className="px-3 py-2 text-[#666]">{row.model}</td>
                                <td className="px-3 py-2 text-right">{row.calls}</td>
                                <td className="px-3 py-2 text-right text-[#666]">{row.input_tokens.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right text-[#666]">{row.output_tokens.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right font-semibold">${row.cost.toFixed(4)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 className="text-xs uppercase tracking-wider text-[#999] font-semibold mb-2">
                      Log complet ({usageData.log?.length ?? 0} dernier{(usageData.log?.length ?? 0) > 1 ? 's' : ''} appel{(usageData.log?.length ?? 0) > 1 ? 's' : ''})
                    </h3>
                    <div className="border border-[#EDE8E0] rounded-xl overflow-hidden max-h-96 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-[#F5F0EA] text-[#666] sticky top-0">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold">Date</th>
                            <th className="text-left px-3 py-2 font-semibold">Fonction</th>
                            <th className="text-left px-3 py-2 font-semibold">Sujet</th>
                            <th className="text-right px-3 py-2 font-semibold">In</th>
                            <th className="text-right px-3 py-2 font-semibold">Out</th>
                            <th className="text-right px-3 py-2 font-semibold">Coût</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(usageData.log ?? []).map((row: any) => (
                            <tr key={row.id} className="border-t border-[#EDE8E0]">
                              <td className="px-3 py-2 text-[#666] whitespace-nowrap">
                                {new Date(row.created_at).toLocaleString('fr-FR', {
                                  day: '2-digit', month: '2-digit',
                                  hour: '2-digit', minute: '2-digit',
                                })}
                              </td>
                              <td className="px-3 py-2 text-[#1a1a1a]">{row.function_name}</td>
                              <td className="px-3 py-2 text-[#666] truncate max-w-[200px]" title={row.email_subject ?? ''}>
                                {row.email_subject ?? '—'}
                              </td>
                              <td className="px-3 py-2 text-right text-[#666]">{row.input_tokens.toLocaleString()}</td>
                              <td className="px-3 py-2 text-right text-[#666]">{row.output_tokens.toLocaleString()}</td>
                              <td className="px-3 py-2 text-right font-semibold">${row.cost_usd.toFixed(5)}</td>
                            </tr>
                          ))}
                          {(usageData.log ?? []).length === 0 && (
                            <tr>
                              <td colSpan={6} className="text-center py-6 text-[#999]">Aucun appel enregistré</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { Email, Classification, Stats, CLASSIFICATION_CONFIG } from '../types'
import EmailCard from './EmailCard'
import EmailDetail from './EmailDetail'

const COLUMNS: Classification[] = ['URGENT', 'IMPORTANT', 'NORMAL', 'FAIBLE']

export default function Dashboard() {
  const [emails, setEmails]           = useState<Email[]>([])
  const [stats, setStats]             = useState<Stats[]>([])
  const [selectedEmail, setSelected]  = useState<Email | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [polling, setPolling]         = useState(false)
  const [pollResult, setPollResult]   = useState<string | null>(null)
  const [pollProgress, setPollProgress] = useState<{ done: number; total: number } | null>(null)
  const [unreadCount, setUnreadCount] = useState<number | null>(null)

  const fetchEmails = useCallback(async () => {
    try {
      const res  = await fetch('/api/emails')
      const data = await res.json()
      setEmails(data.emails  ?? [])
      setStats(data.stats    ?? [])
      setLastRefresh(new Date())
    } catch (err) {
      console.error('Erreur fetchEmails:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res  = await fetch('/api/poll?count=true')
      const data = await res.json()
      if (data.count !== undefined) setUnreadCount(data.count)
    } catch {
      // silencieux
    }
  }, [])

  useEffect(() => {
    fetchEmails()
    fetchUnreadCount()
    const interval = setInterval(() => {
      fetchEmails()
      fetchUnreadCount()
    }, 2 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchEmails, fetchUnreadCount])

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

    let totalProcessed = 0
    const MAX_ITERATIONS = 20

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      try {
        const res  = await fetch('/api/poll')
        const text = await res.text()
        let data: any
        try { data = JSON.parse(text) } catch { data = null }

        if (!res.ok || !data?.success) {
          setPollResult(`Erreur ${res.status} — voir logs Netlify`)
          break
        }

        totalProcessed += data.processed
        setPollProgress({ done: totalProcessed, total: totalProcessed + (data.total ?? 0) })

        if (data.processed > 0) fetchEmails()
        if (data.processed === 0) break  // plus rien à traiter

      } catch (err) {
        setPollResult(`Réseau : ${err instanceof Error ? err.message : 'inconnu'}`)
        break
      }
    }

    setPollResult(totalProcessed > 0 ? `${totalProcessed} email(s) traité(s)` : 'Aucun nouveau mail')
    setPolling(false)
    setPollProgress(null)
    fetchUnreadCount()
    setTimeout(() => setPollResult(null), 8000)
  }

  // Après valider/rejeter : fermer et rafraîchir
  const handleAction = () => {
    setSelected(null)
    fetchEmails()
    fetchUnreadCount()
  }

  const countForColumn = (classification: Classification) =>
    emails.filter(e => e.classification === classification).length

  const totalForColumn = (classification: Classification) => {
    const relevant = stats.filter(s => s.classification === classification)
    return relevant.reduce((sum, s) => sum + parseInt(s.count), 0)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-8rem)]">

      {/* ── Colonnes du Kanban ── */}
      <div className="flex gap-4 flex-1">
        {COLUMNS.map(classification => {
          const conf         = CLASSIFICATION_CONFIG[classification]
          const columnEmails = emails.filter(e => e.classification === classification)

          return (
            <div key={classification} className="flex-1 flex flex-col min-w-0">
              <div className={`flex items-center justify-between px-3 py-2 rounded-lg mb-3 ${conf.bg} ${conf.border} border`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    classification === 'URGENT'    ? 'bg-red-500' :
                    classification === 'IMPORTANT' ? 'bg-orange-500' :
                    classification === 'NORMAL'    ? 'bg-yellow-500' :
                    'bg-green-500'
                  }`} />
                  <span className={`font-semibold text-sm ${conf.color}`}>{conf.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${conf.badge}`}>
                    {countForColumn(classification)}
                  </span>
                  <span className="text-xs text-gray-400">/ {totalForColumn(classification)}</span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {columnEmails.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">
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

      {/* ── Modal email ── */}
      {selectedEmail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) handleClose() }}
        >
          <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-xl overflow-hidden shadow-2xl">
            <EmailDetail
              email={selectedEmail}
              onClose={handleClose}
              onAction={handleAction}
            />
          </div>
        </div>
      )}

      {/* ── Barre du bas ── */}
      <div className="fixed bottom-4 right-6 text-xs text-gray-400 flex items-center gap-3">

        {/* Résultat / progression */}
        {polling && pollProgress ? (
          <span className="text-gray-500 font-medium">
            Traitement {pollProgress.done} / {pollProgress.total}...
          </span>
        ) : pollResult ? (
          <span className={`px-2.5 py-1 rounded-lg font-medium ${
            pollResult.startsWith('Erreur') || pollResult.startsWith('Réseau')
              ? 'bg-red-50 text-red-600'
              : 'bg-green-50 text-green-700'
          }`}>
            {pollResult}
          </span>
        ) : null}

        {/* Badge mails non lus */}
        {unreadCount !== null && unreadCount > 0 && (
          <span className="bg-indigo-100 text-indigo-700 font-bold px-2 py-0.5 rounded-full">
            {unreadCount} non lu{unreadCount > 1 ? 's' : ''}
          </span>
        )}

        <button
          onClick={handlePoll}
          disabled={polling}
          className="hover:text-indigo-600 transition-colors underline underline-offset-2 disabled:opacity-50"
        >
          {polling ? 'Polling...' : 'Lancer le polling'}
        </button>
        <span>·</span>
        <button
          onClick={fetchEmails}
          className="hover:text-indigo-600 transition-colors underline underline-offset-2"
        >
          Actualiser
        </button>
        <span>— {lastRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  )
}

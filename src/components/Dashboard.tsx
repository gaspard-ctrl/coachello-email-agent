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

  useEffect(() => {
    fetchEmails()
    const interval = setInterval(fetchEmails, 2 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchEmails])

  // Ouvrir un email : tenter de verrouiller, puis afficher le modal
  const handleOpen = async (email: Email) => {
    try {
      const res = await fetch(`/api/emails/${email.id}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'team' }),
      })
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}))
        alert(`Cet email est en cours de traitement par ${(data as any).locked_by ?? 'un collègue'}`)
        return
      }
      if (res.ok) {
        setEmails(prev => prev.map(e => e.id === email.id ? { ...e, status: 'locked' } : e))
      }
    } catch {
      // Lock failed (DB indisponible) — on ouvre quand même en lecture
    }
    setSelected(email)
  }

  // Fermer le modal : déverrouiller
  const handleClose = async () => {
    if (!selectedEmail) return
    try {
      await fetch(`/api/emails/${selectedEmail.id}/unlock`, { method: 'POST' })
    } catch {
      // ignore
    }
    setSelected(null)
    fetchEmails()
  }

  const handlePoll = async () => {
    setPolling(true)
    setPollResult(null)
    try {
      const res  = await fetch('/api/poll')
      const data = await res.json()
      if (data.success) {
        setPollResult(
          data.processed > 0
            ? `${data.processed} email(s) traité(s)`
            : 'Aucun nouveau mail'
        )
        if (data.processed > 0) fetchEmails()
      } else {
        setPollResult(`Erreur : ${data.error ?? 'inconnue'}`)
      }
    } catch {
      setPollResult('Impossible de contacter le serveur')
    }
    setPolling(false)
    setTimeout(() => setPollResult(null), 5000)
  }

  // Après valider/rejeter : fermer et rafraîchir
  const handleAction = () => {
    setSelected(null)
    fetchEmails()
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

      {/* ── Colonnes du Kanban (toujours visibles) ── */}
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
        {pollResult && (
          <span className={`px-2.5 py-1 rounded-lg font-medium ${
            pollResult.startsWith('Erreur') || pollResult.startsWith('Impossible')
              ? 'bg-red-50 text-red-600'
              : 'bg-green-50 text-green-700'
          }`}>
            {pollResult}
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

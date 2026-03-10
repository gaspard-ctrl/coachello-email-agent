import { useState, useEffect, useCallback, Component } from 'react'
import { createPortal } from 'react-dom'
import { Email, Classification, CLASSIFICATION_CONFIG } from '../types'
import EmailCard from './EmailCard'
import EmailDetail from './EmailDetail'

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

  const fetchEmails = useCallback(async () => {
    try {
      const res  = await fetch('/api/emails')
      const data = await res.json()
      setEmails(data.emails  ?? [])
      setLastRefresh(new Date())
      setRefreshed(true)
      setTimeout(() => setRefreshed(false), 2000)
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

    try {
      const res  = await fetch('/api/manual-poll')
      const text = await res.text()
      let data: any
      try { data = JSON.parse(text) } catch { data = null }

      if (!res.ok || !data?.success) {
        setPollResult(`Erreur ${res.status}${data?.error ? ` : ${data.error}` : ''}`)
      } else {
        setPollResult(data.processed > 0 ? `${data.processed} email(s) traité(s)` : 'Aucun nouveau mail')
        if (data.processed > 0) fetchEmails()
      }
    } catch (err) {
      setPollResult(`Erreur réseau`)
    }

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
              <div className="flex items-center justify-between px-3 py-2.5 rounded-2xl mb-3 bg-white border border-gray-100 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${
                    classification === 'URGENT'    ? 'bg-red-500' :
                    classification === 'IMPORTANT' ? 'bg-orange-400' :
                    classification === 'NORMAL'    ? 'bg-blue-400' :
                    'bg-gray-400'
                  }`} />
                  <span className="font-semibold text-sm text-gray-800">{conf.label}</span>
                </div>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${conf.badge}`}>
                  {countForColumn(classification)}
                </span>
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

      {/* ── Modal email (Portal sur document.body pour éviter tout problème CSS) ── */}
      {selectedEmail && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={e => { if (e.target === e.currentTarget) handleClose() }}
        >
          <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl">
            <ModalErrorBoundary onClose={handleClose}>
              <EmailDetail
                email={selectedEmail}
                onClose={handleClose}
                onAction={handleAction}
              />
            </ModalErrorBoundary>
          </div>
        </div>,
        document.body
      )}

      {/* ── Barre du bas ── */}
      <div className="fixed bottom-4 right-6 text-xs text-gray-400 flex items-center gap-3">

        {/* Résultat / progression */}
        {polling && pollProgress ? (
          <span className="text-gray-500 font-medium">
            Traitement {pollProgress.done} / {pollProgress.total}...
          </span>
        ) : pollResult ? (
          <span className={`px-2.5 py-1 rounded-full font-medium ${
            pollResult.startsWith('Erreur') || pollResult.startsWith('Réseau')
              ? 'bg-red-50 text-red-600'
              : 'bg-gray-100 text-gray-700'
          }`}>
            {pollResult}
          </span>
        ) : null}

        {/* Badge mails non lus */}
        {unreadCount !== null && unreadCount > 0 && (
          <span className="bg-black text-white font-semibold px-2.5 py-0.5 rounded-full">
            {unreadCount} non lu{unreadCount > 1 ? 's' : ''}
          </span>
        )}

        <button
          onClick={handlePoll}
          disabled={polling}
          className="hover:text-black transition-colors underline underline-offset-2 disabled:opacity-40"
        >
          {polling ? 'Polling...' : 'Lancer le polling'}
        </button>
        <span>·</span>
        <button
          onClick={fetchEmails}
          className="hover:text-black transition-colors underline underline-offset-2"
        >
          {refreshed ? 'Actualisé ✓' : 'Actualiser'}
        </button>
        <span>— {lastRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  )
}

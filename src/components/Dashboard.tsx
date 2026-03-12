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
      const res      = await fetch('/api/emails')
      const data     = await res.json()
      const newEmails: Email[] = data.emails ?? []
      setEmails(newEmails)
      setSelected(prev => prev ? (newEmails.find(e => e.id === prev.id) ?? prev) : null)
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
    <div className="flex gap-4 h-[calc(100vh-8rem)]">

      {/* ── Colonnes du Kanban ── */}
      <div className="flex gap-4 flex-1">
        {COLUMNS.map(classification => {
          const conf         = CLASSIFICATION_CONFIG[classification]
          const colStyle     = COLUMN_STYLE[classification]
          const columnEmails = emails.filter(e => e.classification === classification)

          return (
            <div key={classification} className="flex-1 flex flex-col min-w-0">
              <div className={`flex items-center justify-between px-3 py-2.5 rounded-2xl mb-3 ${colStyle.header}`}>
                <span className={`text-xs uppercase tracking-wider ${colStyle.label}`}>{conf.label}</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${colStyle.badge}`}>
                  {countForColumn(classification)}
                </span>
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
          <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl">
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

      {/* ── Barre du bas ── */}
      <div className="fixed bottom-4 right-6 text-xs text-[#aaa] flex items-center gap-3">

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

        {/* Badge mails non lus */}
        {unreadCount !== null && unreadCount > 0 && (
          <span className="bg-[#E8452A] text-white font-bold px-2.5 py-0.5 rounded-full">
            {unreadCount} non lu{unreadCount > 1 ? 's' : ''}
          </span>
        )}

        <button
          onClick={handlePoll}
          disabled={polling}
          className="hover:text-[#E8452A] transition-colors underline underline-offset-2 disabled:opacity-40"
        >
          {polling ? 'Polling...' : 'Lancer le polling'}
        </button>
        <span className="text-[#D8D0C5]">·</span>
        <button
          onClick={fetchEmails}
          className="hover:text-[#E8452A] transition-colors underline underline-offset-2"
        >
          {refreshed ? 'Actualisé ✓' : 'Actualiser'}
        </button>
        <span>— {lastRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  )
}

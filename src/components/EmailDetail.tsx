import { useState, useEffect, useRef } from 'react'
import { Email, CLASSIFICATION_CONFIG } from '../types'

interface Props {
  email: Email
  onClose: () => void
  onAction: () => void
  onRefresh?: () => Promise<void>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

export default function EmailDetail({ email, onClose, onAction, onRefresh }: Props) {
  const [response, setResponse]   = useState(email.draft_response ?? '')
  const [loading, setLoading]     = useState(false)
  const [mode, setMode]           = useState<'view' | 'edit'>('view')
  const [feedback, setFeedback]   = useState<string | null>(null)

  // ── Context panel ──
  const [contextText, setContextText]           = useState('')
  const [showContext, setShowContext]           = useState(false)
  const [redraftLoading, setRedraftLoading]     = useState(false)
  const [waitingForRedraft, setWaitingForRedraft] = useState(false)
  const originalDraftRef = useRef('')

  const conf        = CLASSIFICATION_CONFIG[email.classification] ?? CLASSIFICATION_CONFIG['NORMAL']
  const body        = email.body_text || email.body_preview || '(corps vide)'
  const attachments = Array.isArray(email.attachments) ? email.attachments : []
  const gmailUrl    = `https://mail.google.com/mail/u/0/#inbox/${email.gmail_id}`

  const handleRedraft = async () => {
    if (!contextText.trim()) return
    setRedraftLoading(true)
    setWaitingForRedraft(true)
    originalDraftRef.current = response
    try {
      await fetch('/api/redraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: email.id, context: contextText }),
      })
      // 202 reçu — le résultat arrivera via polling
    } catch {
      setFeedback('Erreur réseau')
      setRedraftLoading(false)
      setWaitingForRedraft(false)
    }
  }

  // Poll toutes les 3s tant qu'on attend le redraft
  useEffect(() => {
    if (!waitingForRedraft) return
    const interval = setInterval(() => { onRefresh?.() }, 3000)
    const timeout  = setTimeout(() => {
      setWaitingForRedraft(false)
      setRedraftLoading(false)
      setFeedback('Délai dépassé, réessaie')
    }, 90000)
    return () => { clearInterval(interval); clearTimeout(timeout) }
  }, [waitingForRedraft, onRefresh])

  // Détecter quand draft_response change dans la DB
  useEffect(() => {
    if (!waitingForRedraft) return
    if (email.draft_response && email.draft_response !== originalDraftRef.current) {
      setResponse(email.draft_response)
      setWaitingForRedraft(false)
      setRedraftLoading(false)
      setShowContext(false)
      setContextText('')
      setFeedback('Brouillon régénéré ✓')
    }
  }, [email.draft_response, waitingForRedraft])

  const sendAction = async (action: 'validate' | 'reject' | 'draft' | 'report') => {
    setLoading(true)
    setFeedback(null)
    try {
      const res = await fetch(`/api/emails/${email.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'team', final_response: response }),
      })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error ?? 'Erreur')

      if (action === 'validate') {
        setFeedback(data.action === 'sent' ? 'Réponse envoyée ✓' : 'Brouillon enregistré dans Gmail ✓')
        setTimeout(onAction, 1200)
      } else if (action === 'draft') {
        setFeedback('Brouillon enregistré dans Gmail ✓')
        setTimeout(onAction, 1200)
      } else if (action === 'report') {
        setFeedback('Email signalé comme spam ✓')
        setTimeout(onAction, 800)
      } else {
        setFeedback('Email marqué comme lu')
        setTimeout(onAction, 800)
      }
    } catch (err: unknown) {
      setFeedback(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
      setLoading(false)
    }
  }

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString('fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })

  const BADGE_STYLE: Record<string, string> = {
    URGENT:    'bg-[#F0024F] text-white',
    IMPORTANT: 'bg-[#F768A8] text-white',
    NORMAL:    'bg-[#FBBED7] text-[#A5002E]',
    FAIBLE:    'bg-[#FDE8F2] text-[#C8A0BE]',
  }

  return (
    <div className="bg-white flex flex-col" style={{ maxHeight: '90vh' }}>

      {/* ── En-tête ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0EDE8] bg-white flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0 uppercase tracking-wide ${BADGE_STYLE[email.classification] ?? BADGE_STYLE['NORMAL']}`}>
            {conf.label}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1a1a1a] truncate">{email.subject}</p>
            <p className="text-xs text-[#aaa] truncate">
              {email.from_name && `${email.from_name} · `}{email.from_email} · {formatDate(email.received_at)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-4">
          <a
            href={gmailUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-[#aaa] hover:text-[#E8452A] underline underline-offset-2 transition-colors"
          >
            Ouvrir dans Gmail
          </a>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-[#F5F0EA] rounded-full transition-colors text-[#bbb] hover:text-[#555]"
            title="Fermer"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ── Corps : email + brouillon ── */}
      <div className="flex-1 overflow-hidden grid grid-cols-2 divide-x divide-[#F0EDE8]" style={{ minHeight: 0 }}>

        {/* Gauche : email reçu */}
        <div className="overflow-y-auto p-5 flex flex-col gap-4">
          <div>
            <h3 className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest mb-3">
              Email reçu
            </h3>
            <div className="text-sm text-[#444] whitespace-pre-wrap leading-relaxed">
              {body}
            </div>
          </div>

          {/* Pièces jointes */}
          {attachments.length > 0 && (
            <div>
              <h3 className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest mb-2">
                Pièces jointes ({attachments.length})
              </h3>
              <div className="flex flex-col gap-1.5">
                {attachments.map((att, i) => (
                  <div key={i} className="flex items-center gap-2 bg-[#F7F5F2] border border-[#EDE8E0] rounded-xl px-3 py-2">
                    <span className="text-base">📎</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[#333] truncate">{att.filename}</p>
                      <p className="text-xs text-[#aaa]">{formatSize(att.size)}</p>
                    </div>
                    <a
                      href={gmailUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-[#aaa] hover:text-[#E8452A] flex-shrink-0 transition-colors"
                    >
                      Voir dans Gmail
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Analyse Claude */}
          {email.reasoning && (
            <div className="p-3 bg-[#F7F5F2] rounded-xl border border-[#EDE8E0]">
              <p className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest mb-1.5">Analyse de l'agent</p>
              <p className="text-xs text-[#666] leading-relaxed">{email.reasoning}</p>
            </div>
          )}
        </div>

        {/* Droite : brouillon de réponse */}
        <div className="overflow-y-auto p-5 flex flex-col gap-4 bg-[#FDFCFB]">

          {/* Brouillon */}
          <div className="flex flex-col flex-1">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest">
                Brouillon de réponse
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowContext(v => !v)}
                  className="text-xs text-[#E8452A] hover:text-[#c83a22] underline underline-offset-2 transition-colors font-medium"
                >
                  {showContext ? 'Masquer' : 'Donner du contexte'}
                </button>
                <span className="text-[#D8D0C5]">|</span>
                <button
                  onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}
                  className="text-xs text-[#aaa] hover:text-[#555] underline underline-offset-2 transition-colors"
                >
                  {mode === 'view' ? '✏️ Modifier' : '👁 Aperçu'}
                </button>
              </div>
            </div>

            {mode === 'view' ? (
              <div className="text-sm text-[#444] whitespace-pre-wrap leading-relaxed flex-1">
                {response || <span className="text-[#ccc] italic">Aucun brouillon généré</span>}
              </div>
            ) : (
              <textarea
                value={response}
                onChange={e => setResponse(e.target.value)}
                className="flex-1 text-sm text-[#444] leading-relaxed border border-[#D8D0C5] rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#E8452A] min-h-[200px] bg-white"
                placeholder="Réponse..."
              />
            )}
          </div>

          {/* Panneau contexte libre */}
          {showContext && (
            <div className="border border-[#E8E2D9] rounded-xl p-4 bg-[#F7F5F2] flex flex-col gap-3">
              <p className="text-[10px] font-bold text-[#aaa] uppercase tracking-widest">
                Contexte / instructions pour Claude
              </p>
              <textarea
                value={contextText}
                onChange={e => setContextText(e.target.value)}
                rows={4}
                className="text-sm border border-[#D8D0C5] rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8452A] bg-white resize-none text-[#444]"
                placeholder="Ex: répondre en anglais, mentionner l'offre Pro, ton formel, proposer un appel..."
              />
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => { setShowContext(false); setContextText('') }}
                  className="text-xs text-[#aaa] hover:text-[#555] underline underline-offset-2"
                >
                  Annuler
                </button>
                <button
                  onClick={handleRedraft}
                  disabled={redraftLoading || !contextText.trim()}
                  className="btn-primary text-xs disabled:opacity-40"
                >
                  {redraftLoading ? (
                    <span className="flex items-center gap-1.5">
                      <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                      Rédaction...
                    </span>
                  ) : 'Régénérer →'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Barre d'actions ── */}
      <div className="px-5 py-3 bg-white border-t border-[#F0EDE8] flex items-center justify-between gap-3 flex-shrink-0">
        <p className="text-xs text-[#bbb]">
          "Brouillon Gmail" pour réviser dans Gmail · "Envoyer" pour envoyer directement
        </p>

        <div className="flex items-center gap-2">
          {feedback ? (
            <span className="text-sm font-semibold text-[#555] bg-[#EDE8E0] px-3 py-1.5 rounded-full">
              {feedback}
            </span>
          ) : (
            <>
              <button
                onClick={() => sendAction('report')}
                disabled={loading}
                className="btn-danger text-sm"
              >
                Signaler
              </button>
              <button
                onClick={() => sendAction('reject')}
                disabled={loading}
                className="btn-ghost text-sm"
              >
                Mark as read
              </button>
              <button
                onClick={() => sendAction('draft')}
                disabled={loading || !response.trim()}
                className="btn-ghost text-sm"
              >
                {loading ? '...' : 'Brouillon Gmail'}
              </button>
              <button
                onClick={() => sendAction('validate')}
                disabled={loading || !response.trim()}
                className="btn-success text-sm"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Envoi...
                  </span>
                ) : (
                  'Envoyer'
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

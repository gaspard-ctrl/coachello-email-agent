import { useState, useEffect, useRef } from 'react'
import DOMPurify from 'dompurify'
import { Email, EmailAttachment, CLASSIFICATION_CONFIG } from '../types'

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

  // ── Réponses reçues dans le même thread ──
  const [threadReplies, setThreadReplies] = useState<{ from_name: string; from_email: string; received_at: string }[]>([])

  // ── Pièces jointes sortantes ──
  const [outgoingFiles, setOutgoingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Context panel ──
  const [contextText, setContextText]           = useState('')
  const [showContext, setShowContext]           = useState(false)
  const [redraftLoading, setRedraftLoading]     = useState(false)
  const [waitingForRedraft, setWaitingForRedraft] = useState(false)
  const originalDraftRef = useRef('')

  const [showQuoted, setShowQuoted] = useState(false)
  const [previewAtt, setPreviewAtt] = useState<{ url: string; filename: string; mimeType: string } | null>(null)
  const htmlRef = useRef<HTMLDivElement>(null)

  const conf        = CLASSIFICATION_CONFIG[email.classification] ?? CLASSIFICATION_CONFIG['NORMAL']
  const body        = email.body_text || email.body_preview || '(corps vide)'
  const attachments: EmailAttachment[] = (() => {
    let raw = email.attachments;
    if (!raw) return [];
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return []; }
    }
    return Array.isArray(raw) ? raw : [];
  })()
  const gmailUrl    = `https://mail.google.com/mail/u/0/#inbox/${email.gmail_id}`

  // Séparer le dernier message du fil cité (mode texte)
  const splitThread = (text: string) => {
    const match = text.match(/\n(On .{5,80} wrote:[\s\S]*$)/i)
      ?? text.match(/\n(Le .{5,80} a écrit\s*:[\s\S]*$)/i)
      ?? text.match(/\n(-{3,}.*(?:Forwarded|Original|Transféré)[\s\S]*$)/i)
    if (match && match.index !== undefined) {
      return { latest: text.slice(0, match.index), quoted: match[1] }
    }
    return { latest: text, quoted: '' }
  }
  const { latest: latestBody, quoted: quotedBody } = splitThread(body)

  // Résoudre les images inline (cid: → proxy URL) puis sanitizer
  const resolvedHtml = (() => {
    if (!email.body_html) return '';
    let html = email.body_html;
    // Remplacer les cid: par le proxy d'attachments
    const inlineAtts = attachments.filter(a => a.contentId);
    for (const att of inlineAtts) {
      const proxyUrl = `/api/attachment?gmailId=${encodeURIComponent(email.gmail_id)}&attachmentId=${encodeURIComponent(att.attachmentId)}&mimeType=${encodeURIComponent(att.mimeType)}`;
      html = html.replace(
        new RegExp(`cid:${att.contentId!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'),
        proxyUrl,
      );
    }
    return html;
  })();

  const sanitizedHtml = resolvedHtml ? DOMPurify.sanitize(resolvedHtml, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
    ADD_ATTR: ['target', 'src', 'alt', 'width', 'height', 'style'],
    ADD_DATA_URI_TAGS: ['img'],
    ALLOW_DATA_ATTR: true,
  }) : ''

  // Rendre les blockquotes cliquables (expand/collapse) dans le HTML
  useEffect(() => {
    if (!htmlRef.current || !sanitizedHtml) return
    const bqs = htmlRef.current.querySelectorAll('blockquote')
    const handlers: Array<() => void> = []
    bqs.forEach(bq => {
      const handler = () => bq.classList.toggle('expanded')
      bq.addEventListener('click', handler)
      handlers.push(() => bq.removeEventListener('click', handler))
    })
    return () => handlers.forEach(h => h())
  }, [sanitizedHtml])

  // Lock à l'ouverture, unlock à la fermeture
  useEffect(() => {
    fetch(`/api/emails/${email.id}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'team' }) }).catch(() => {})
    return () => { fetch(`/api/emails/${email.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'team' }) }).catch(() => {}) }
  }, [email.id])

  // Chercher les réponses reçues dans le même thread (status sent, exclu l'email courant)
  useEffect(() => {
    if (!email.thread_id) return
    fetch(`/api/emails?status=sent`)
      .then(r => r.json())
      .then((data: { emails?: { id: string; thread_id: string; from_name: string; from_email: string; received_at: string }[] }) => {
        const replies = (data.emails ?? []).filter(
          e => e.thread_id === email.thread_id && e.id !== email.id
        )
        setThreadReplies(replies)
      })
      .catch(() => {})
  }, [email.thread_id, email.id])

  const handleRedraft = async () => {
    if (!contextText.trim()) return
    setRedraftLoading(true)
    setWaitingForRedraft(true)
    originalDraftRef.current = email.draft_response ?? ''
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
      setTimeout(() => setFeedback(null), 3000)
    }
  }, [email.draft_response, waitingForRedraft])

  const convertFilesToBase64 = async (files: File[]) => {
    return Promise.all(files.map(f => new Promise<{ filename: string; mimeType: string; data: string }>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve({ filename: f.name, mimeType: f.type || 'application/octet-stream', data: base64 })
      }
      reader.readAsDataURL(f)
    })))
  }

  const totalFileSize = outgoingFiles.reduce((sum, f) => sum + f.size, 0)

  const sendAction = async (action: 'validate' | 'reject' | 'draft' | 'report') => {
    setLoading(true)
    setFeedback(null)
    try {
      const attachments = outgoingFiles.length > 0 ? await convertFilesToBase64(outgoingFiles) : undefined
      const res = await fetch(`/api/emails/${email.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'team', final_response: response, attachments }),
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

  const sendAndSave = async () => {
    setLoading(true)
    setFeedback(null)
    try {
      const attachments = outgoingFiles.length > 0 ? await convertFilesToBase64(outgoingFiles) : undefined
      // 1. Envoyer l'email
      const res = await fetch(`/api/emails/${email.id}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'team', final_response: response, attachments }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Erreur lors de l\'envoi')

      // 2. Enregistrer dans le guide des réponses
      const saveRes = await fetch('/api/examples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_subject:   email.subject,
          email_from:      email.from_email,
          email_body:      email.body_text || email.body_preview || '(corps non disponible)',
          ideal_response:  response,
          classification:  email.classification,
          notes:           '',
        }),
      })
      if (!saveRes.ok) throw new Error('Envoyé, mais erreur lors de la sauvegarde dans le guide')

      setFeedback('Réponse envoyée & exemple enregistré ✓')
      setTimeout(onAction, 1500)
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
    <div className="bg-white flex flex-col flex-1" style={{ minHeight: '70vh', maxHeight: '95vh' }}>

      {/* ── En-tête ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0EDE8] bg-white flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0 uppercase tracking-wide ${BADGE_STYLE[email.classification] ?? BADGE_STYLE['NORMAL']}`}>
            {conf.label}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1a1a1a] truncate">{email.subject}</p>
            <p className="text-xs text-[#aaa] truncate">
              <span className="font-medium text-[#888]">De :</span> {email.from_name && `${email.from_name} `}&lt;{email.from_email}&gt; · {formatDate(email.received_at)}
            </p>
            {email.to_email && (
              <p className="text-xs text-[#aaa] truncate">
                <span className="font-medium text-[#888]">À :</span> {email.to_email}
              </p>
            )}
            {email.cc_emails && (
              <p className="text-xs text-[#aaa] truncate">
                <span className="font-medium text-[#888]">Cc :</span> {email.cc_emails}
              </p>
            )}
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
          {/* Analyse Claude — en haut pour être visible sans scroller */}
          {threadReplies.length > 0 && (
            <div className="p-3 bg-[#FFF8E6] rounded-xl border border-[#F5D97A]">
              <p className="text-[10px] font-bold text-[#B8860B] uppercase tracking-widest mb-1.5">
                {threadReplies.length === 1 ? '1 réponse reçue dans ce fil' : `${threadReplies.length} réponses reçues dans ce fil`}
              </p>
              {threadReplies.map((r, i) => (
                <p key={i} className="text-xs text-[#7A5F00]">
                  {r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email} · {formatDate(r.received_at)}
                </p>
              ))}
            </div>
          )}

          {email.reasoning && (
            <div className="p-3 bg-[#F7F5F2] rounded-xl border border-[#EDE8E0]">
              <p className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest mb-1.5">Analyse de l'agent</p>
              <p className="text-xs text-[#666] leading-relaxed">{email.reasoning}</p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest">
                Email reçu
              </h3>
            </div>

            {sanitizedHtml ? (
              <div
                ref={htmlRef}
                className="text-sm text-[#444] leading-relaxed email-html-body"
                dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
              />
            ) : (
              <div className="text-sm text-[#444] whitespace-pre-wrap leading-relaxed">
                {latestBody}
                {quotedBody && (
                  <>
                    <button
                      onClick={() => setShowQuoted(v => !v)}
                      className="block mt-2 text-xs text-[#aaa] hover:text-[#555] underline underline-offset-2"
                    >
                      {showQuoted ? 'Masquer le fil' : 'Voir le fil de discussion...'}
                    </button>
                    {showQuoted && (
                      <div className="mt-2 pl-3 border-l-2 border-[#D8D0C5] text-[#999]">
                        {quotedBody}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Pièces jointes — cartes compactes, clic pour preview */}
          {attachments.length > 0 && (
            <div>
              <h3 className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest mb-2">
                Pièces jointes ({attachments.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {attachments.map((att, i) => {
                  const proxyUrl = `/api/attachment?gmailId=${encodeURIComponent(email.gmail_id)}&attachmentId=${encodeURIComponent(att.attachmentId)}&mimeType=${encodeURIComponent(att.mimeType)}`;
                  const isImage = att.mimeType.startsWith('image/');
                  const isPdf = att.mimeType === 'application/pdf';
                  const canPreview = isImage || isPdf;
                  const icon = isImage ? '🖼' : isPdf ? '📄' : '📎';

                  return (
                    <button
                      key={i}
                      onClick={() => canPreview && setPreviewAtt({ url: proxyUrl, filename: att.filename, mimeType: att.mimeType })}
                      className={`flex items-center gap-2 bg-[#F7F5F2] border border-[#EDE8E0] rounded-xl px-3 py-2 text-left transition-colors ${canPreview ? 'hover:bg-[#EDE8E0] hover:border-[#D8D0C5] cursor-pointer' : 'cursor-default'}`}
                    >
                      <span className="text-base flex-shrink-0">{icon}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#333] truncate max-w-[180px]">{att.filename}</p>
                        <p className="text-[10px] text-[#aaa]">{formatSize(att.size)}{canPreview ? ' · Cliquer pour voir' : ''}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
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

            {/* Panneau contexte — au-dessus du brouillon pour être visible sans scroller */}
            {showContext && (
              <div className="border border-[#E8E2D9] rounded-xl p-4 bg-[#F7F5F2] flex flex-col gap-3 mb-3">
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

            {waitingForRedraft ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 border border-dashed border-[#E8E2D9] rounded-xl bg-[#F7F5F2] min-h-[200px]">
                <div className="animate-spin h-6 w-6 border-2 border-[#E8452A] border-t-transparent rounded-full" />
                <p className="text-xs text-[#888] font-medium">Rédaction du nouveau brouillon...</p>
              </div>
            ) : mode === 'view' ? (
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

          {/* Pièces jointes sortantes */}
          <div>
            <input
              type="file"
              ref={fileInputRef}
              multiple
              hidden
              onChange={e => {
                const files = Array.from(e.target.files ?? [])
                setOutgoingFiles(prev => [...prev, ...files])
                e.target.value = ''
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-xs text-[#E8452A] hover:text-[#c83a22] underline underline-offset-2 font-medium"
            >
              + Joindre un fichier
            </button>
            {outgoingFiles.length > 0 && (
              <div className="flex flex-col gap-1 mt-2">
                {outgoingFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs bg-[#F7F5F2] border border-[#EDE8E0] rounded-lg px-2.5 py-1.5">
                    <span className="truncate flex-1 text-[#444]">{f.name} ({formatSize(f.size)})</span>
                    <button
                      onClick={() => setOutgoingFiles(prev => prev.filter((_, j) => j !== i))}
                      className="text-[#aaa] hover:text-red-500 flex-shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {totalFileSize > 4 * 1024 * 1024 && (
                  <p className="text-xs text-red-500 mt-1">Total &gt; 4 Mo — l'envoi risque d'échouer</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Barre d'actions ── */}
      <div className="px-5 py-3 bg-white border-t border-[#F0EDE8] flex-shrink-0">
        {feedback ? (
          <div className="flex justify-center">
            <span className="text-sm font-semibold text-[#555] bg-[#EDE8E0] px-4 py-2 rounded-full">
              {feedback}
            </span>
          </div>
        ) : (
          <div className="flex gap-2">
              <button
                onClick={() => sendAction('report')}
                disabled={loading}
                className="flex-1 btn-danger text-sm"
              >
                Signaler
              </button>
              <button
                onClick={() => sendAction('reject')}
                disabled={loading}
                className="flex-1 btn-ghost text-sm"
              >
                Mark as read
              </button>
              <button
                onClick={() => sendAction('draft')}
                disabled={loading || !response.trim()}
                className="flex-1 btn-ghost text-sm"
              >
                {loading ? '...' : 'Brouillon Gmail'}
              </button>
              <button
                onClick={() => sendAction('validate')}
                disabled={loading || !response.trim()}
                className="flex-1 btn-success text-sm"
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
              <button
                onClick={sendAndSave}
                disabled={loading || !response.trim()}
                className="flex-1 text-sm px-4 py-2 rounded-xl font-semibold bg-[#F768A8] hover:bg-[#F0024F] text-white transition-colors disabled:opacity-40"
                title="Envoyer l'email et enregistrer cet échange dans le guide des réponses"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Envoi...
                  </span>
                ) : (
                  'Envoyer & Enregistrer'
                )}
              </button>
          </div>
        )}
      </div>

      {/* ── Popup preview pièce jointe ── */}
      {previewAtt && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setPreviewAtt(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            style={{ width: '85vw', height: '85vh', maxWidth: '1200px' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#F0EDE8] flex-shrink-0">
              <p className="text-sm font-semibold text-[#333] truncate">{previewAtt.filename}</p>
              <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                <a
                  href={previewAtt.url}
                  download={previewAtt.filename}
                  className="text-xs text-[#E8452A] hover:text-[#c83a22] font-medium underline underline-offset-2 transition-colors"
                >
                  Telecharger
                </a>
                <button
                  onClick={() => setPreviewAtt(null)}
                  className="p-1.5 hover:bg-[#F5F0EA] rounded-full transition-colors text-[#bbb] hover:text-[#555]"
                >
                  ✕
                </button>
              </div>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-auto flex items-center justify-center bg-[#F7F5F2] p-4">
              {previewAtt.mimeType.startsWith('image/') ? (
                <img
                  src={previewAtt.url}
                  alt={previewAtt.filename}
                  className="max-w-full max-h-full object-contain rounded-lg shadow-sm"
                />
              ) : (
                <iframe
                  src={previewAtt.url}
                  title={previewAtt.filename}
                  className="w-full h-full rounded-lg border-0"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

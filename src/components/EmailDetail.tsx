import { useState, useEffect, useRef } from 'react'
import DOMPurify from 'dompurify'
import { Email, EmailAttachment, CLASSIFICATION_CONFIG } from '../types'
import ThreadView, { ReplyTarget } from './ThreadView'

interface Props {
  email: Email
  onClose: () => void
  onAction: () => void
  onRefresh?: () => Promise<void>
  /** Si true, Claude est en train d'analyser cet email — spinner sur le brouillon. */
  analyzing?: boolean
  /** Si fourni, l'email n'est pas encore analysé : on affiche une zone d'instructions + "Faire rédiger par Claude" au lieu du brouillon. */
  onAnalyze?: (context?: string) => void
  /** Mode inline (utilisé dans Dashboard à côté de la liste). Sans ce flag, on rend en modal full-screen. */
  inline?: boolean
  /** Callback pour transférer l'email (ouvre Compose pré-rempli). */
  onForward?: (email: Email) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `Aujourd'hui à ${time}`
  if (isYesterday) return `Hier à ${time}`
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) + ` à ${time}`
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "à l'instant"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}j`
}

const AVATAR_COLORS = ['bg-rose-500', 'bg-sky-500', 'bg-amber-500', 'bg-emerald-500', 'bg-violet-500', 'bg-orange-500', 'bg-teal-500', 'bg-fuchsia-500']
function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}
function initials(name: string, email: string): string {
  const src = (name || email || '?').trim()
  const parts = src.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

// ── Helpers destinataires (Cc) ──
// Extrait l'adresse d'une entrée "Nom <email>" ou "email".
function emailOf(addr: string): string {
  const m = addr.match(/<([^>]+)>/)
  return (m ? m[1] : addr).toLowerCase().trim()
}
// Nom affichable (prénom/nom si présent, sinon l'email).
function nameOf(addr: string): string {
  const m = addr.match(/^\s*"?(.*?)"?\s*<([^>]+)>\s*$/)
  const nm = m ? m[1].trim() : ''
  return nm || emailOf(addr)
}
// Découpe une liste d'adresses "a@x.com, Nom <b@y.com>" (split naïf sur virgule, comme le backend).
function splitAddrs(raw?: string): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

// Parse un body_text contenant des messages quotés en plusieurs ThreadMessage.
interface ThreadMessage {
  from?: string
  to?: string
  cc?: string
  date?: string
  subject?: string
  body: string
  type: 'reply' | 'forward' | 'original'
}
function parseThreadMessages(text: string): ThreadMessage[] {
  const messages: ThreadMessage[] = []
  const replyEn = /\n(?=On .{5,120} wrote:\s*\n)/gi
  const replyFr = /\n(?=Le .{5,120} a écrit\s*:\s*\n)/gi
  const fwdSep = /\n(?=-{3,}.*(?:Forwarded|Transféré|Original).*-{3,}\s*\n)/gi
  const splitPoints: Array<{ index: number; type: 'reply' | 'forward' }> = []
  for (const regex of [replyEn, replyFr]) {
    let m; while ((m = regex.exec(text)) !== null) splitPoints.push({ index: m.index, type: 'reply' })
  }
  { let m; while ((m = fwdSep.exec(text)) !== null) splitPoints.push({ index: m.index, type: 'forward' }) }
  splitPoints.sort((a, b) => a.index - b.index)
  if (splitPoints.length === 0) return [{ body: text.trim(), type: 'original' }]
  const firstChunk = text.slice(0, splitPoints[0].index).trim()
  if (firstChunk) messages.push({ body: firstChunk, type: 'original' })
  for (let i = 0; i < splitPoints.length; i++) {
    const start = splitPoints[i].index
    const end = i + 1 < splitPoints.length ? splitPoints[i + 1].index : text.length
    const chunk = text.slice(start, end).trim()
    const msgType = splitPoints[i].type
    const msg: ThreadMessage = { body: '', type: msgType }
    if (msgType === 'reply') {
      const m = chunk.match(/^On (.+?) wrote:\s*\n([\s\S]*)$/i) ?? chunk.match(/^Le (.+?) a écrit\s*:\s*\n([\s\S]*)$/i)
      if (m) {
        const head = m[1]
        const em = head.match(/<([^>]+)>/); const nm = head.match(/,\s*(.+?)\s*</)
        if (em) msg.from = nm ? `${nm[1].trim()} <${em[1]}>` : em[1]
        const dateStr = head.replace(/,\s*.+?<[^>]+>/, '').replace(/,\s*[^\s,]+@\S+/, '').trim()
        if (dateStr) msg.date = dateStr
        msg.body = m[2].replace(/^>+ ?/gm, '').trim()
      } else msg.body = chunk
    } else {
      const lines = chunk.split('\n'); let headerEnd = 0
      if (lines[0]?.match(/^-{3,}/)) headerEnd = 1
      for (let j = headerEnd; j < lines.length; j++) {
        const line = lines[j].trim()
        if (!line) { headerEnd = j + 1; break }
        const fromM = line.match(/^(?:From|De)\s*:\s*(.+)/i)
        const toM = line.match(/^(?:To|À)\s*:\s*(.+)/i)
        const ccM = line.match(/^(?:Cc|Cci)\s*:\s*(.+)/i)
        const dateM = line.match(/^(?:Date)\s*:\s*(.+)/i)
        const subjM = line.match(/^(?:Subject|Objet)\s*:\s*(.+)/i)
        if (fromM) msg.from = fromM[1].trim()
        else if (toM) msg.to = toM[1].trim()
        else if (ccM) msg.cc = ccM[1].trim()
        else if (dateM) msg.date = dateM[1].trim()
        else if (subjM) msg.subject = subjM[1].trim()
        else { headerEnd = j; break }
      }
      msg.body = lines.slice(headerEnd).join('\n').trim()
    }
    messages.push(msg)
  }
  return messages
}

export default function EmailDetail({ email, onClose, onAction, analyzing, onAnalyze, inline, onForward }: Props) {
  const [response, setResponse] = useState(email.draft_response ?? '')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [feedback, setFeedback] = useState<string | null>(null)

  const [outgoingFiles, setOutgoingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [contextText, setContextText] = useState('')
  const [redraftLoading, setRedraftLoading] = useState(false)

  // Cible de réponse : null = dernier message (comportement par défaut), sinon un message précis du thread.
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null)

  // Destinataires en copie (Cc) de la réponse — éditables (chips + ajout).
  const [selfEmail, setSelfEmail] = useState('')
  const [ccList, setCcList] = useState<string[]>([])
  const [ccInput, setCcInput] = useState('')
  const [ccError, setCcError] = useState<string | null>(null)

  const [previewAtt, setPreviewAtt] = useState<{ url: string; filename: string; mimeType: string } | null>(null)
  const [openPrev, setOpenPrev] = useState<Record<number, boolean>>({ 0: true })
  const [detailsPrev, setDetailsPrev] = useState<Record<number, boolean>>({})
  const htmlRef = useRef<HTMLDivElement>(null)

  const conf = CLASSIFICATION_CONFIG[email.classification] ?? CLASSIFICATION_CONFIG['NORMAL']
  const body = email.body_text || email.body_preview || '(corps vide)'
  const attachments: EmailAttachment[] = Array.isArray(email.attachments) ? email.attachments : []
  const fileAttachments = attachments.filter(a => !a.contentId || a.filename !== 'inline')
  const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${email.gmail_id}`

  const threadMessages = parseThreadMessages(body)

  // Résoudre images inline cid: dans le HTML
  const resolvedHtml = (() => {
    if (!email.body_html) return ''
    let html = email.body_html
    for (const att of attachments.filter(a => a.contentId)) {
      const proxyUrl = `/api/attachment?gmailId=${encodeURIComponent(email.gmail_id)}&attachmentId=${encodeURIComponent(att.attachmentId)}&mimeType=${encodeURIComponent(att.mimeType)}`
      html = html.replace(new RegExp(`cid:${att.contentId!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), proxyUrl)
    }
    return html
  })()
  const sanitizedHtml = resolvedHtml ? DOMPurify.sanitize(resolvedHtml, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
    ADD_ATTR: ['target', 'src', 'alt', 'width', 'height', 'style'],
    ADD_DATA_URI_TAGS: ['img'],
    ALLOW_DATA_ATTR: true,
  }) : ''

  // Quand l'email change (notamment après une analyse), recharger le brouillon
  useEffect(() => {
    setResponse(email.draft_response ?? '')
    setReplyTarget(null)
  }, [email.id, email.draft_response])

  // Adresse de la boîte gérée ("moi") — pour s'exclure des destinataires en Cc.
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => { if (!cancelled) setSelfEmail((d?.settings?.gmail_address ?? '').toLowerCase()) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Cc par défaut = reply-all (To + Cc du message cible) sauf nous-mêmes et le destinataire "À".
  // Recalculé quand on change d'email, de cible de réponse, ou quand on connaît "moi".
  useEffect(() => {
    const recipientEmail = emailOf(replyTarget ? replyTarget.from : email.from_email)
    const srcTo = replyTarget ? replyTarget.to : (email.to_email ?? '')
    const srcCc = replyTarget ? (replyTarget.cc ?? '') : (email.cc_emails ?? '')
    const seen = new Set<string>()
    const auto = [...splitAddrs(srcTo), ...splitAddrs(srcCc)].filter(a => {
      const e = emailOf(a)
      if (!e || e === recipientEmail || (selfEmail && e === selfEmail)) return false
      if (seen.has(e)) return false
      seen.add(e); return true
    })
    setCcList(auto)
    setCcInput('')
    setCcError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id, replyTarget, selfEmail])

  const addCc = () => {
    const raw = ccInput.trim().replace(/[;,]\s*$/, '').trim()
    if (!raw) return
    const e = emailOf(raw)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      setCcError('Adresse email invalide')
      setTimeout(() => setCcError(null), 2500)
      return
    }
    if (ccList.some(a => emailOf(a) === e) || (selfEmail && e === selfEmail)) { setCcInput(''); return }
    setCcList(prev => [...prev, raw])
    setCcInput('')
    setCcError(null)
  }
  const removeCc = (idx: number) => setCcList(prev => prev.filter((_, i) => i !== idx))

  // Lock à l'ouverture, unlock à la fermeture (sauf en mode analyzing — pas d'id DB stable)
  useEffect(() => {
    if (analyzing || email.id.startsWith('tmp-')) return
    fetch(`/api/emails/${email.id}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'team' }) }).catch(() => {})
    return () => { fetch(`/api/emails/${email.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'team' }) }).catch(() => {}) }
  }, [email.id, analyzing])

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

  const handleRedraft = async () => {
    if (!contextText.trim() && response.trim()) return
    setRedraftLoading(true)
    try {
      const res = await fetch('/api/redraft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: email.id, ...(contextText.trim() ? { context: contextText } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.draft_response) {
        setResponse(data.draft_response)
        setFeedback('Brouillon régénéré ✓')
        setTimeout(() => setFeedback(null), 2500)
      } else {
        setFeedback('Régénération en cours...')
        setTimeout(() => setFeedback(null), 3000)
      }
      setContextText('')
    } catch {
      setFeedback('Erreur réseau')
      setTimeout(() => setFeedback(null), 3000)
    }
    setRedraftLoading(false)
  }

  const convertFilesToBase64 = async (files: File[]) =>
    Promise.all(files.map(f => new Promise<{ filename: string; mimeType: string; data: string }>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve({ filename: f.name, mimeType: f.type || 'application/octet-stream', data: base64 })
      }
      reader.readAsDataURL(f)
    })))

  const totalFileSize = outgoingFiles.reduce((sum, f) => sum + f.size, 0)

  const isTmp = email.id.startsWith('tmp-')

  const tmpMeta = isTmp ? {
    gmail_id:   email.gmail_id,
    thread_id:  email.thread_id,
    from_email: email.from_email,
    to_email:   email.to_email,
    cc_emails:  email.cc_emails,
    subject:    email.subject,
  } : undefined

  // Override "répondre à un message précis du thread" envoyé au backend.
  const replyOverride = replyTarget ? {
    reply_from:      replyTarget.from,
    reply_to:        replyTarget.to,
    reply_cc:        replyTarget.cc ?? '',
    reply_gmail_id:  replyTarget.gmail_id,
  } : undefined

  const sendAction = async (action: 'validate' | 'reject' | 'draft' | 'report') => {
    setLoading(true)
    setFeedback(null)
    try {
      const atts = outgoingFiles.length > 0 ? await convertFilesToBase64(outgoingFiles) : undefined
      const res = await fetch(`/api/emails/${email.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'team', final_response: response, attachments: atts, ...(tmpMeta ?? {}), ...(replyOverride ?? {}), ...(email.thread_id ? { cc_override: ccList.join(', ') } : {}) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Erreur')
      const msg = action === 'validate' ? (data.action === 'sent' ? 'Réponse envoyée ✓' : 'Brouillon Gmail ✓')
                : action === 'draft' ? 'Brouillon enregistré dans Gmail ✓'
                : action === 'report' ? 'Email signalé ✓'
                : 'Marqué comme lu ✓'
      setFeedback(msg)
      setTimeout(onAction, 1200)
    } catch (err: unknown) {
      setFeedback(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
      setLoading(false)
    }
  }

  const sendAndSave = async () => {
    setLoading(true); setFeedback(null)
    try {
      const atts = outgoingFiles.length > 0 ? await convertFilesToBase64(outgoingFiles) : undefined
      const res = await fetch(`/api/emails/${email.id}/validate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'team', final_response: response, attachments: atts, ...(tmpMeta ?? {}), ...(replyOverride ?? {}), ...(email.thread_id ? { cc_override: ccList.join(', ') } : {}) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Erreur lors de l'envoi")
      const saveRes = await fetch('/api/examples', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_subject: email.subject, email_from: email.from_email,
          email_body: email.body_text || email.body_preview || '(corps non disponible)',
          ideal_response: response, classification: email.classification, notes: '',
        }),
      })
      if (!saveRes.ok) throw new Error('Envoyé, mais erreur lors de la sauvegarde')
      setFeedback('Envoyé & enregistré ✓')
      setTimeout(onAction, 1500)
    } catch (err: unknown) {
      setFeedback(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
      setLoading(false)
    }
  }

  const fromDomain = (email.from_email || '').split('@')[1] || ''
  const senderInitials = initials(email.from_name || '', email.from_email || '')
  const senderAvatar = avatarColor(email.from_email || email.from_name || email.id)
  const showBundlePill = !onAnalyze && !analyzing && email.classification

  const innerContent = (
    <>
      {/* ── Corps : [thread] | [draft] ── */}
      <div className="flex-1 overflow-hidden flex flex-col md:flex-row" style={{ minHeight: 0 }}>

        {/* Gauche : entête + thread */}
        <div className="basis-[600px] grow-[600] shrink min-w-0 flex flex-col overflow-hidden">

          {/* Compact header */}
          <div className="border-b border-[#EDE8E0] flex-shrink-0 px-5 pt-4 pb-3">
            <div className="flex items-start gap-3">
              <div className={`w-9 h-9 rounded-full ${senderAvatar} text-white text-[11px] font-bold flex items-center justify-center shrink-0`}>
                {senderInitials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-[#1a1a1a] truncate">
                  {email.from_name || email.from_email}
                  {fromDomain && <span className="text-[#aaa] font-normal"> · {fromDomain}</span>}
                </div>
                <div className="text-[11px] text-[#aaa]" title={new Date(email.received_at).toLocaleString()}>
                  à moi · {timeAgo(email.received_at)}
                </div>
                <div className="flex items-center gap-2 mt-1.5 min-w-0">
                  {showBundlePill && (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0 ${conf.badge}`}>
                      {conf.label}
                    </span>
                  )}
                  {(onAnalyze || analyzing) && (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#EDE8E0] text-[#888] border border-[#D8D0C5] flex-shrink-0">
                      Non analysé
                    </span>
                  )}
                  <h2 className="text-[15px] font-semibold text-[#1a1a1a] truncate">{email.subject}</h2>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <a href={gmailUrl} target="_blank" rel="noreferrer" className="text-xs text-[#aaa] hover:text-[#E8452A] p-1.5 rounded-lg hover:bg-[#F5F0EA] transition-colors" title="Ouvrir dans Gmail">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
                <button onClick={onClose} className="p-1.5 hover:bg-[#F5F0EA] rounded-full text-[#aaa] hover:text-[#555] transition-colors" title="Fermer (Esc)">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
          </div>

          {/* Thread + attachments — scrollable */}
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
            {email.thread_id ? (
              <ThreadView threadId={email.thread_id} latestGmailId={email.gmail_id} onReply={setReplyTarget} activeReplyGmailId={replyTarget?.gmail_id} />
            ) : sanitizedHtml ? (
              <div ref={htmlRef} className="text-[14px] text-[#444] leading-relaxed email-html-body" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
            ) : (
              <div>
                {threadMessages.map((msg, i) => {
                  const isOpen = !!openPrev[i]
                  const isDetails = !!detailsPrev[i]
                  const displayFrom = msg.from || (i === 0 ? (email.from_name || email.from_email) : 'Message précédent')
                  const snippet = (msg.body || '').replace(/\s+/g, ' ').slice(0, 140)
                  const dateLabel = i === 0 ? formatDate(email.received_at) : (msg.date || '')
                  const detailsTo = i === 0 ? email.to_email : msg.to
                  const detailsCc = i === 0 ? email.cc_emails : msg.cc
                  return (
                    <div key={i} className="border-b border-[#F0EDE8] last:border-b-0">
                      <button
                        onClick={() => setOpenPrev(prev => ({ ...prev, [i]: !prev[i] }))}
                        className="w-full flex items-start gap-2 py-2.5 text-left hover:bg-[#F7F5F2]/60 transition-colors -mx-2 px-2 rounded"
                      >
                        <svg className={`w-3.5 h-3.5 text-[#bbb] mt-1 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`truncate ${isOpen ? 'text-[14px] font-semibold text-[#1a1a1a]' : 'text-[13px] font-medium text-[#444]'}`}>{displayFrom}</span>
                            {msg.type === 'forward' && <span className="text-[10px] text-[#aaa]">transféré</span>}
                            {isOpen && (
                              <button
                                onClick={e => { e.stopPropagation(); setDetailsPrev(prev => ({ ...prev, [i]: !prev[i] })) }}
                                className="text-[#bbb] hover:text-[#666] transition-colors p-0.5 rounded"
                                title={isDetails ? 'Masquer détails' : 'Détails'}
                              >
                                <svg className={`w-3 h-3 transition-transform ${isDetails ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                                </svg>
                              </button>
                            )}
                          </div>
                          {!isOpen && snippet && <p className="text-[12px] text-[#aaa] truncate">{snippet}</p>}
                          {isOpen && isDetails && (
                            <div className="mt-1.5 text-[11.5px] text-[#888] space-y-0.5 leading-snug">
                              {detailsTo && <div><span className="text-[#aaa]">À </span>{detailsTo}</div>}
                              {detailsCc && <div><span className="text-[#aaa]">Cc </span>{detailsCc}</div>}
                            </div>
                          )}
                        </div>
                        {dateLabel && <span className="text-[11px] text-[#aaa] whitespace-nowrap flex-shrink-0">{dateLabel}</span>}
                      </button>
                      {isOpen && (
                        <div className="pb-4 pt-1 pl-5 text-[14px] text-[#444] leading-relaxed whitespace-pre-wrap">{msg.body}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Attachments (uniquement quand pas de thread — sinon affichées par ThreadView par message) */}
            {!email.thread_id && fileAttachments.length > 0 && (
              <div>
                <h3 className="text-[10px] font-bold text-[#bbb] uppercase tracking-widest mb-2">
                  Pièces jointes ({fileAttachments.length})
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {fileAttachments.map((att, i) => {
                    const baseParams = new URLSearchParams({
                      gmailId: email.gmail_id,
                      attachmentId: att.attachmentId,
                      mimeType: att.mimeType,
                      filename: att.filename,
                    })
                    const previewUrl = `/api/attachment?${baseParams.toString()}`
                    const downloadUrl = `/api/attachment?${baseParams.toString()}&download=1`
                    const isImage = att.mimeType.startsWith('image/')
                    const isPdf = att.mimeType === 'application/pdf'
                    const canPreview = isImage || isPdf
                    const ext = att.filename.split('.').pop()?.toUpperCase() || '?'
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-1 bg-white border border-[#EDE8E0] rounded-xl pl-3 pr-1.5 py-1.5 hover:bg-[#F7F5F2] hover:border-[#D8D0C5] transition-all group"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (canPreview) setPreviewAtt({ url: previewUrl, filename: att.filename, mimeType: att.mimeType })
                            else window.location.assign(downloadUrl)
                          }}
                          className="flex items-center gap-3 flex-1 min-w-0 text-left py-1"
                          title={canPreview ? 'Aperçu' : 'Télécharger'}
                        >
                          <div className="w-9 h-9 rounded-lg bg-[#F5F0EA] flex items-center justify-center shrink-0">
                            {isImage ? <span className="text-[10px] font-bold text-[#E8452A]">IMG</span>
                              : isPdf ? <span className="text-[10px] font-bold text-red-500">PDF</span>
                                : <span className="text-[9px] font-bold text-[#888]">{ext}</span>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-[#444] truncate">{att.filename}</p>
                            <p className="text-[10px] text-[#aaa]">{formatSize(att.size)}</p>
                          </div>
                        </button>
                        <a
                          href={downloadUrl}
                          download={att.filename}
                          onClick={e => e.stopPropagation()}
                          className="p-2 rounded-lg text-[#888] hover:text-[#E8452A] hover:bg-[#F5F0EA] transition-colors shrink-0"
                          title="Télécharger"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                          </svg>
                        </a>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Droite : Analyse + Brouillon — pleine hauteur, largeur proportionnelle */}
        <div className="flex flex-col bg-white overflow-hidden border-t md:border-t-0 md:border-l border-[#EDE8E0] w-full md:basis-[461px] md:grow-[461] md:shrink-0 md:min-w-[380px]">

          {/* Analyse de l'agent */}
          {!analyzing && !onAnalyze && email.reasoning && (
            <div className="px-5 py-4 border-b border-[#EDE8E0] flex-shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-4 h-4 text-[#E8452A]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <h3 className="text-[11px] font-bold text-[#888] uppercase tracking-widest">Analyse de l'agent</h3>
              </div>
              <p className="text-sm text-[#555] leading-relaxed">{email.reasoning}</p>
            </div>
          )}

          <div className="flex-1 flex flex-col overflow-hidden">

            {/* Header brouillon */}
            <div className="px-5 pt-4 pb-1 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-[#E8452A]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <h3 className="text-[11px] font-bold text-[#888] uppercase tracking-widest">Brouillon</h3>
              </div>
              <div className="flex items-center gap-3">
                {!analyzing && !onAnalyze && response.trim() && (
                  <button
                    onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}
                    className="text-[11px] text-[#aaa] hover:text-[#555] underline underline-offset-2 transition-colors"
                  >
                    {mode === 'view' ? '✏️ Modifier' : '👁 Aperçu'}
                  </button>
                )}
              </div>
            </div>

            {/* Destinataires de la réponse : À (modifiable via "Répondre à ce message") + Cc éditables */}
            {!analyzing && email.thread_id && (
              <div className="px-5 pb-1.5 flex flex-col gap-1 flex-shrink-0 text-[12px] min-w-0">
                {/* À */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[#aaa] flex-shrink-0 w-7">À :</span>
                  <span className="font-medium text-[#444] truncate" title={replyTarget ? replyTarget.from : email.from_email}>
                    {replyTarget ? replyTarget.name : (email.from_name || email.from_email)}
                  </span>
                  {replyTarget ? (
                    <button
                      onClick={() => setReplyTarget(null)}
                      className="text-[11px] text-[#aaa] hover:text-[#E8452A] underline underline-offset-2 transition-colors flex-shrink-0 ml-1"
                      title="Revenir au dernier message du thread"
                    >
                      revenir au dernier message
                    </button>
                  ) : (
                    <span className="text-[10px] text-[#bbb] flex-shrink-0 ml-1 truncate">(« Répondre à ce message » dans le fil pour changer)</span>
                  )}
                </div>
                {/* Cc — destinataires en copie, éditables */}
                <div className="flex items-start gap-1.5 min-w-0">
                  <span className="text-[#aaa] flex-shrink-0 w-7 mt-1">Cc :</span>
                  <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
                    {ccList.map((addr, i) => (
                      <span key={emailOf(addr) + i} className="inline-flex items-center gap-1 bg-[#F5F0EA] border border-[#E8E2D9] rounded-full pl-2 pr-1 py-0.5 max-w-full" title={addr}>
                        <span className="truncate text-[#555] max-w-[160px]">{nameOf(addr)}</span>
                        <button onClick={() => removeCc(i)} className="text-[#bbb] hover:text-[#E8452A] transition-colors flex-shrink-0" title="Retirer de la copie">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </span>
                    ))}
                    <input
                      value={ccInput}
                      onChange={e => setCcInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCc() } }}
                      onBlur={addCc}
                      placeholder={ccList.length ? 'Ajouter…' : 'Ajouter un destinataire en copie…'}
                      className="flex-1 min-w-[130px] bg-transparent text-[12px] text-[#444] placeholder-[#bbb] focus:outline-none py-0.5"
                    />
                  </div>
                </div>
                {ccError && <div className="pl-8 text-[11px] text-red-500">{ccError}</div>}
              </div>
            )}

            {/* Zone de brouillon (analyse en cours / éditeur) */}
            {analyzing ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 m-5 border border-dashed border-[#E8E2D9] rounded-xl bg-[#F7F5F2] min-h-[200px] px-6">
                <div className="animate-spin h-6 w-6 border-2 border-[#E8452A] border-t-transparent rounded-full" />
                <p className="text-xs text-[#888] font-medium text-center">L'agent analyse cet email...</p>
                <p className="text-[10px] text-[#aaa] text-center">Classification + brouillon de réponse en cours</p>
              </div>
            ) : mode === 'view' && !onAnalyze ? (
              <div className="flex-1 overflow-y-auto px-5 py-3 text-sm text-[#444] whitespace-pre-wrap leading-relaxed">
                {response || <span className="text-[#ccc] italic">Aucun brouillon généré</span>}
              </div>
            ) : (
              <textarea
                value={response}
                onChange={e => setResponse(e.target.value)}
                className="flex-1 m-5 text-sm text-[#444] leading-relaxed border border-[#D8D0C5] rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#E8452A] bg-white"
                placeholder={onAnalyze ? "Écris ta réponse… ou clique sur « Faire rédiger par Claude »" : "Réponse..."}
              />
            )}

            {/* Zone "Faire rédiger par Claude" avec instructions optionnelles — emails non analysés */}
            {!analyzing && onAnalyze && (
              <div className="border-t border-[#EDE8E0] p-3 flex items-center gap-2 bg-[#F7F5F2]/40 flex-shrink-0">
                <input
                  type="text"
                  value={contextText}
                  onChange={e => setContextText(e.target.value)}
                  placeholder="Instructions pour Claude (optionnel)..."
                  className="flex-1 min-w-0 text-[13px] border border-[#D8D0C5] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8452A] bg-white"
                  onKeyDown={e => { if (e.key === 'Enter') { onAnalyze(contextText); setContextText('') } }}
                />
                <button
                  onClick={() => { onAnalyze(contextText); setContextText('') }}
                  className="btn-primary text-[12px] px-3 py-2 flex items-center gap-1.5 flex-shrink-0"
                  title="Demander à Claude de classifier et rédiger un brouillon"
                >
                  ✨ Faire rédiger par Claude
                </button>
              </div>
            )}

            {/* Redraft avec instructions — réservé aux emails analysés (besoin d'une row DB) */}
            {!analyzing && !onAnalyze && (
              <div className="border-t border-[#EDE8E0] p-3 flex items-center gap-2 bg-[#F7F5F2]/40 flex-shrink-0">
                <input
                  type="text"
                  value={contextText}
                  onChange={e => setContextText(e.target.value)}
                  placeholder="Régénérer avec des instructions..."
                  className="flex-1 min-w-0 text-[13px] border border-[#D8D0C5] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8452A] bg-white"
                  onKeyDown={e => { if (e.key === 'Enter') handleRedraft() }}
                />
                <button
                  onClick={handleRedraft}
                  disabled={redraftLoading}
                  className="btn-primary text-[12px] px-3 py-2 flex items-center gap-1.5 flex-shrink-0"
                >
                  {redraftLoading ? (
                    <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      Régénérer
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Compose toolbar */}
            {!analyzing && (
              <div className="flex-shrink-0 px-4 py-3 border-t border-[#EDE8E0]">
                <input type="file" ref={fileInputRef} multiple hidden onChange={e => { setOutgoingFiles(prev => [...prev, ...Array.from(e.target.files ?? [])]); e.target.value = '' }} />
                <div className="flex items-center gap-1">
                  <button onClick={() => fileInputRef.current?.click()} className="text-xs text-[#888] hover:text-[#E8452A] font-medium inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-[#F5F0EA] transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    Joindre un fichier
                  </button>
                </div>
                {outgoingFiles.length > 0 && (
                  <div className="flex flex-col gap-1.5 mt-2">
                    {outgoingFiles.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs bg-white border border-[#EDE8E0] rounded-lg px-3 py-2">
                        <span className="truncate flex-1 font-medium">{f.name}</span>
                        <span className="text-[#aaa] shrink-0">{formatSize(f.size)}</span>
                        <button onClick={() => setOutgoingFiles(prev => prev.filter((_, j) => j !== i))} className="text-[#ccc] hover:text-red-500 transition-colors shrink-0">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}
                    {totalFileSize > 4 * 1024 * 1024 && (
                      <p className="text-xs text-red-500">Total &gt; 4 Mo — l'envoi risque d'échouer</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Barre d'actions partagée ── */}
      <div className="px-5 py-3 bg-white border-t border-[#EDE8E0] flex-shrink-0">
        {analyzing ? (
          <div className="flex justify-center">
            <span className="text-xs font-medium text-[#888]">Les actions seront disponibles dès la fin de l'analyse…</span>
          </div>
        ) : feedback ? (
          <div className="flex justify-center">
            <span className="text-sm font-semibold text-[#555] bg-[#EDE8E0] px-4 py-2 rounded-full">{feedback}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex gap-2">
              <button onClick={() => sendAction('report')} disabled={loading} className="btn-danger text-sm px-4 py-2">Signaler</button>
              <button onClick={() => sendAction('reject')} disabled={loading} className="btn-ghost text-sm px-4 py-2">Marquer comme lu</button>
              {onForward && (
                <button onClick={() => onForward(email)} disabled={loading} className="btn-ghost text-sm px-4 py-2 inline-flex items-center gap-1.5" title="Transférer cet email">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h11a4 4 0 014 4v3m0 0l-4-4m4 4l-4 4" />
                  </svg>
                  Transférer
                </button>
              )}
            </div>
            <div className="flex-1" />
            <div className="flex gap-2">
              <button onClick={() => sendAction('draft')} disabled={loading || !response.trim()} className="btn-ghost text-sm px-4 py-2">Brouillon Gmail</button>
              <button onClick={() => sendAction('validate')} disabled={loading || !response.trim()} className="btn-success text-sm px-5 py-2">
                {loading ? (
                  <span className="flex items-center gap-2"><span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />Envoi...</span>
                ) : 'Envoyer'}
              </button>
              {!onAnalyze && (
                <button onClick={sendAndSave} disabled={loading || !response.trim()} className="btn-primary text-sm px-4 py-2" title="Envoyer et enregistrer dans le guide">
                  {loading ? 'Envoi...' : 'Envoyer & Enregistrer'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Preview attachement */}
      {previewAtt && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setPreviewAtt(null)}>
          <div className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden" style={{ width: '85vw', height: '85vh', maxWidth: '1200px' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#EDE8E0] flex-shrink-0">
              <p className="text-sm font-semibold truncate">{previewAtt.filename}</p>
              <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                <a href={previewAtt.url.includes('download=1') ? previewAtt.url : `${previewAtt.url}&download=1`} download={previewAtt.filename} className="text-xs text-[#E8452A] font-medium underline underline-offset-2">Télécharger</a>
                <button onClick={() => setPreviewAtt(null)} className="p-1.5 hover:bg-[#F5F0EA] rounded-full text-[#aaa]">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto flex items-center justify-center bg-[#F7F5F2] p-4">
              {previewAtt.mimeType.startsWith('image/') ? (
                <img src={previewAtt.url} alt={previewAtt.filename} className="max-w-full max-h-full object-contain rounded-lg" />
              ) : (
                <iframe src={previewAtt.url} title={previewAtt.filename} className="w-full h-full rounded-lg border-0" />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )

  if (inline) {
    return <div className="basis-[1061px] grow-[1061] shrink min-w-0 flex flex-col overflow-hidden bg-white">{innerContent}</div>
  }

  return (
    <div className="bg-white flex flex-col flex-1" style={{ minHeight: '70vh', maxHeight: '95vh' }}>
      {innerContent}
    </div>
  )
}

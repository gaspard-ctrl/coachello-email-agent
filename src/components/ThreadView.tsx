// Affiche tous les messages d'un thread Gmail récupérés via /api/gmail-thread.
// Chaque message est une ligne repliable (chevron + sender, date) ; le plus
// récent est ouvert par défaut, les autres collapsés. Détails From/To/Cc à la
// demande.

import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { apiGet } from '../lib/api'
import { decodeHtmlEntities } from '../lib/htmlEntities'

interface ThreadAttachment {
  filename: string
  mimeType: string
  size: number
  attachmentId: string
  contentId?: string
}

interface ThreadMessage {
  gmail_id: string
  from: string
  to: string
  cc?: string
  subject: string
  date: string
  snippet: string
  body_text: string
  body_html: string
  is_me: boolean
  is_unread: boolean
  attachments?: ThreadAttachment[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^(.*?)\s*<(.+?)>$/)
  if (m) return { name: m[1].replace(/"/g, '').trim(), email: m[2].trim() }
  return { name: '', email: raw }
}

function formatDate(raw: string): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Retire la portion citée ("On X wrote: ..." / blockquote / -----Original-----)
// puisque le thread complet est déjà affiché message par message en dessous.
function stripQuotedHtml(html: string): string {
  if (!html || typeof window === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')

  doc.querySelectorAll('.gmail_quote, blockquote, .gmail_attr').forEach(n => n.remove())

  // Outlook : tout ce qui suit le séparateur "divRplyFwdMsg" ou "appendonsend"
  const removeFollowingSiblings = (el: Element | null) => {
    if (!el) return
    let node: ChildNode | null = el
    while (node) {
      const next: ChildNode | null = node.nextSibling
      node.parentNode?.removeChild(node)
      node = next
    }
  }
  removeFollowingSiblings(doc.getElementById('appendonsend'))
  doc.querySelectorAll('[id^="divRplyFwdMsg"], [id^="OLK_SRC_BODY_SECTION"]').forEach(n => removeFollowingSiblings(n))

  return doc.body.innerHTML
}

function stripQuotedText(text: string): string {
  if (!text) return text
  return text
    .replace(/\n?On .{5,200} wrote:\s*\n[\s\S]*$/i, '')
    .replace(/\n?Le .{5,200} a écrit\s*:\s*\n[\s\S]*$/i, '')
    .replace(/\n?-{3,}\s*(?:Forwarded message|Original Message|Message d'origine|Message transféré).{0,40}-{3,}[\s\S]*$/i, '')
    .trimEnd()
}

function MessageBlock({ msg, initiallyOpen }: { msg: ThreadMessage; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [showDetails, setShowDetails] = useState(false)
  const { name, email } = parseAddress(msg.from)
  const sanitizedHtml = msg.body_html
    ? DOMPurify.sanitize(stripQuotedHtml(msg.body_html), {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
        ADD_ATTR: ['target', 'src', 'alt', 'width', 'height', 'style'],
        ALLOW_DATA_ATTR: true,
      })
    : ''
  const bodyText = stripQuotedText(msg.body_text)

  return (
    <div className="border-b border-[#F0EDE8] last:border-b-0">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start gap-2 py-2.5 text-left hover:bg-[#F7F5F2]/60 transition-colors -mx-2 px-2 rounded"
      >
        <svg className={`w-3.5 h-3.5 text-[#bbb] mt-1 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`truncate ${open ? 'text-[14px] font-semibold text-[#1a1a1a]' : 'text-[13px] font-medium text-[#444]'}`}>
              {name || email}
            </span>
            {msg.is_me && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#FEE9E5] text-[#E8452A]">moi</span>}
            {open && (
              <button
                onClick={e => { e.stopPropagation(); setShowDetails(v => !v) }}
                className="text-[#bbb] hover:text-[#666] transition-colors p-0.5 rounded"
                title={showDetails ? 'Masquer détails' : 'Détails'}
              >
                <svg className={`w-3 h-3 transition-transform ${showDetails ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>
          {!open && <p className="text-[12px] text-[#aaa] truncate">{decodeHtmlEntities(msg.snippet)}</p>}
          {open && showDetails && (
            <div className="mt-1.5 text-[11.5px] text-[#888] space-y-0.5 leading-snug">
              <div><span className="text-[#aaa]">De </span>{name ? `${name} <${email}>` : email}</div>
              {msg.to && <div><span className="text-[#aaa]">À </span>{msg.to}</div>}
              {msg.cc && <div><span className="text-[#aaa]">Cc </span>{msg.cc}</div>}
            </div>
          )}
        </div>
        <span className="text-[11px] text-[#aaa] whitespace-nowrap flex-shrink-0">{formatDate(msg.date)}</span>
      </button>
      {open && (
        <div className="pb-4 pt-1 pl-5 text-[14px] text-[#444] leading-relaxed">
          {sanitizedHtml ? (
            <div className="email-html-body" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
          ) : (
            <div className="whitespace-pre-wrap">{bodyText || decodeHtmlEntities(msg.snippet)}</div>
          )}
          {/* Pièces jointes du message — filtrer les images inline */}
          {msg.attachments && msg.attachments.filter(a => !a.contentId || a.filename !== 'inline').length > 0 && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {msg.attachments.filter(a => !a.contentId || a.filename !== 'inline').map((att, i) => {
                const proxyUrl = `/api/attachment?gmailId=${encodeURIComponent(msg.gmail_id)}&attachmentId=${encodeURIComponent(att.attachmentId)}&mimeType=${encodeURIComponent(att.mimeType)}`
                const isImage = att.mimeType.startsWith('image/')
                const isPdf = att.mimeType === 'application/pdf'
                const ext = att.filename.split('.').pop()?.toUpperCase() || '?'
                return (
                  <a
                    key={i}
                    href={proxyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 bg-white border border-[#EDE8E0] rounded-xl px-3 py-2.5 hover:bg-[#F7F5F2] hover:border-[#D8D0C5] transition-all"
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
                  </a>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ThreadView({ threadId, latestGmailId }: { threadId: string; latestGmailId?: string }) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!threadId) return
    setMessages(null); setError(null)
    apiGet<{ messages: ThreadMessage[] }>(`/gmail-thread?id=${encodeURIComponent(threadId)}`)
      .then(res => setMessages(res.messages ?? []))
      .catch(err => setError(err?.message ?? 'Erreur de chargement du thread'))
  }, [threadId])

  if (error) return <p className="text-[12px] text-red-600">Impossible de charger le thread : {error}</p>
  if (!messages) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin h-4 w-4 border-2 border-[#E8452A] border-t-transparent rounded-full" />
      </div>
    )
  }
  if (messages.length === 0) return <p className="text-[12px] text-[#aaa]">Aucun message dans ce thread.</p>

  // Afficher du plus récent au plus ancien (ordre habituel d'un thread Gmail).
  const ordered = [...messages].reverse()

  return (
    <div>
      {ordered.map((msg, idx) => {
        const isLatest = latestGmailId ? msg.gmail_id === latestGmailId : idx === 0
        const onlyOne = ordered.length === 1
        const initiallyOpen = onlyOne || isLatest
        return <MessageBlock key={msg.gmail_id} msg={msg} initiallyOpen={initiallyOpen} />
      })}
    </div>
  )
}

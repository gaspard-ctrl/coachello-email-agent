// Liste plate d'emails — calquée sur EmailList.tsx de l'autre app.
// Chaque ligne : point non-lu, sender, subject + snippet, badge classif, date.

import type { GmailEmail, Classification } from '../types'
import { decodeHtmlEntities } from '../lib/htmlEntities'

interface Props {
  emails: GmailEmail[]
  loading: boolean
  onSelect: (email: GmailEmail) => void
  onLoadMore?: () => void
  hasMore?: boolean
  selectable?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (gmailId: string) => void
  /** Toggle lu/non-lu d'un email depuis la liste (icône enveloppe au hover). */
  onToggleRead?: (gmailId: string, currentlyUnread: boolean) => void
}

function timeLabel(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const isThisYear = d.getFullYear() === now.getFullYear()
  if (isToday) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  if (isThisYear) return d.toLocaleDateString('fr-FR', { month: 'short', day: 'numeric' })
  return d.toLocaleDateString('fr-FR', { month: 'short', day: 'numeric', year: 'numeric' })
}

function displayName(email: GmailEmail): string {
  if (email.folder === 'sent' || email.folder === 'drafts') {
    if (email.to_name) return email.to_name
    if (email.to_email) return email.to_email.split('@')[0]
    return '(sans destinataire)'
  }
  if (email.from_name) return email.from_name
  return email.from_email.split('@')[0]
}

function displayPrefix(email: GmailEmail): string | null {
  if (email.folder === 'sent') return 'À :'
  if (email.folder === 'drafts') return 'Brouillon'
  return null
}

const BADGE_STYLE: Record<Classification, string> = {
  URGENT: 'bg-[#F0024F] text-white',
  IMPORTANT: 'bg-[#F768A8] text-white',
  NORMAL: 'bg-[#FBBED7] text-[#A5002E]',
  FAIBLE: 'bg-[#FDE8F2] text-[#C8A0BE]',
}

const BADGE_LABEL: Record<Classification, string> = {
  URGENT: 'Urgent',
  IMPORTANT: 'Important',
  NORMAL: 'Normal',
  FAIBLE: 'Faible',
}

export default function EmailList({
  emails, loading, onSelect, onLoadMore, hasMore,
  selectable, selectedIds, onToggleSelect, onToggleRead,
}: Props) {
  if (loading && emails.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin h-6 w-6 border-2 border-[#E8452A] border-t-transparent rounded-full" />
      </div>
    )
  }
  if (emails.length === 0) {
    return (
      <div className="text-center py-16 text-[#bbb] text-sm">
        Aucun email
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {emails.map((email) => {
        const isSelected = selectedIds?.has(email.gmail_id)
        const prefix = displayPrefix(email)
        const name = displayName(email)
        const isUnread = email.is_unread

        return (
          <div
            key={email.gmail_id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(email)}
            onKeyDown={e => { if (e.key === 'Enter') onSelect(email) }}
            className={`w-full text-left flex items-center gap-3 px-4 py-2.5 border-b border-[#EDE8E0] transition-colors group cursor-pointer overflow-hidden ${
              isUnread ? 'bg-white hover:bg-[#FEE9E5]/30' : 'bg-[#F7F5F2]/40 hover:bg-[#F0EDE8]'
            }`}
          >
            {/* Checkbox */}
            {selectable && (
              <div
                className="flex-shrink-0"
                onClick={e => { e.stopPropagation(); onToggleSelect?.(email.gmail_id) }}
              >
                <div className={`w-[18px] h-[18px] rounded border-[1.5px] flex items-center justify-center transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-[#E8452A] border-[#E8452A]'
                    : 'border-[#D8D0C5] hover:border-[#E8452A] group-hover:border-[#aaa]'
                }`}>
                  {isSelected && (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              </div>
            )}

            {/* Indicateur non-lu */}
            <div className="w-2 flex-shrink-0">
              {email.folder === 'inbox' && isUnread && (
                <div className="w-2 h-2 bg-[#E8452A] rounded-full" />
              )}
              {email.folder === 'sent' && (
                <svg className="w-3 h-3 text-[#bbb] -ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>

            {/* Contenu */}
            <div className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center md:gap-2">
              <div className="flex items-center justify-between md:contents">
                <div className={`md:w-40 md:flex-shrink-0 truncate text-[13px] flex items-center gap-1.5 ${isUnread ? 'font-semibold text-[#1a1a1a]' : 'text-[#666]'}`}>
                  {prefix && <span className="text-[#aaa] mr-1 text-[11px]">{prefix}</span>}
                  <span className="truncate">{name}</span>
                  {email.thread_count && email.thread_count > 1 && (
                    <span className="text-[10px] font-semibold text-[#888] flex-shrink-0">
                      {email.thread_count}
                    </span>
                  )}
                </div>
                <div className={`md:hidden text-[11px] flex-shrink-0 ${isUnread ? 'font-semibold text-[#555]' : 'text-[#aaa]'}`}>
                  {timeLabel(email.received_at)}
                </div>
              </div>

              <div className="flex-1 min-w-0 flex items-baseline gap-2 overflow-hidden">
                <span className={`flex-shrink-0 max-w-[50%] truncate text-[13px] ${isUnread ? 'font-medium text-[#1a1a1a]' : 'text-[#666]'}`}>
                  {email.subject || '(sans objet)'}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px] text-[#aaa] hidden md:inline">
                  {decodeHtmlEntities(email.snippet)}
                </span>
              </div>
            </div>

            {/* Badge */}
            {email.folder === 'inbox' && (
              <div className="flex-shrink-0">
                {email.is_analyzed && email.classification ? (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${BADGE_STYLE[email.classification]}`}>
                    {BADGE_LABEL[email.classification]}
                  </span>
                ) : (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#EDE8E0] text-[#888] border border-[#D8D0C5]">
                    Non analysé
                  </span>
                )}
              </div>
            )}

            {/* Date desktop */}
            <div className={`hidden md:block w-14 flex-shrink-0 text-right text-[11px] ${isUnread ? 'font-medium text-[#555]' : 'text-[#aaa]'}`}>
              {timeLabel(email.received_at)}
            </div>

            {/* Toggle lu/non-lu — apparait au hover */}
            {onToggleRead && email.folder === 'inbox' && (
              <button
                onClick={e => { e.stopPropagation(); onToggleRead(email.gmail_id, isUnread) }}
                title={isUnread ? 'Marquer comme lu' : 'Marquer comme non lu'}
                className="flex-shrink-0 p-1.5 rounded-md text-[#ccc] hover:text-[#E8452A] hover:bg-[#F5F0EA] opacity-60 group-hover:opacity-100 transition-all"
              >
                {isUnread ? (
                  // Enveloppe ouverte = "marquer comme lu"
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l9 6 9-6M3 8v10a2 2 0 002 2h14a2 2 0 002-2V8M3 8l9-5 9 5" />
                  </svg>
                ) : (
                  // Enveloppe fermée = "marquer comme non lu"
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            )}
          </div>
        )
      })}

      {hasMore && onLoadMore && (
        <button
          onClick={onLoadMore}
          disabled={loading}
          className="py-3 text-[13px] text-[#E8452A] hover:text-[#c83a22] font-medium hover:bg-[#F7F5F2] transition-colors disabled:opacity-50"
        >
          {loading ? 'Chargement...' : 'Charger plus'}
        </button>
      )}
    </div>
  )
}

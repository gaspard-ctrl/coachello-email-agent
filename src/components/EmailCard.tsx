import { Email } from '../types'

interface Props {
  email: Email
  onOpen: (email: Email) => void
}

function timeAgo(dateStr: string): string {
  const diff  = Date.now() - new Date(dateStr).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)

  if (mins < 1)   return 'à l\'instant'
  if (mins < 60)  return `il y a ${mins} min`
  if (hours < 24) return `il y a ${hours}h`
  return `il y a ${days}j`
}

const LEFT_BORDER: Record<string, string> = {
  URGENT:    '#F0024F',
  IMPORTANT: '#F768A8',
  NORMAL:    '#FBBED7',
  FAIBLE:    '#FDE8F2',
}

export default function EmailCard({ email, onOpen }: Props) {
  return (
    <button
      onClick={() => onOpen(email)}
      className="w-full text-left bg-white border border-[#EDE8E0] rounded-2xl p-4 transition-all duration-150 hover:shadow-md hover:-translate-y-0.5 cursor-pointer shadow-sm"
      style={{ borderLeft: `3px solid ${LEFT_BORDER[email.classification] ?? 'transparent'}` }}
    >
      {/* Expéditeur + heure */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <p className="text-[13px] font-semibold text-[#1a1a1a] truncate leading-tight">
          {email.from_name || email.from_email}
        </p>
        <span className="text-[11px] text-[#bbb] flex-shrink-0 font-medium">{timeAgo(email.received_at)}</span>
      </div>

      {/* Objet */}
      <p className="text-[12px] text-[#555] truncate mb-2 font-medium">
        {email.subject}
      </p>

      {/* Aperçu brouillon */}
      {email.draft_preview && (
        <p className="text-[11px] text-[#aaa] line-clamp-2 leading-relaxed">
          {email.draft_preview}
        </p>
      )}
    </button>
  )
}

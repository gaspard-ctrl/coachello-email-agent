import { Email, CLASSIFICATION_CONFIG } from '../types'

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

export default function EmailCard({ email, onOpen }: Props) {
  const conf = CLASSIFICATION_CONFIG[email.classification]

  return (
    <button
      onClick={() => onOpen(email)}
      className={`w-full text-left p-3 rounded-lg border transition-all duration-150 ${conf.bg} ${conf.border} hover:shadow-md hover:-translate-y-0.5 cursor-pointer`}
    >
      {/* En-tête carte */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-gray-700 truncate">
            {email.from_name || email.from_email}
          </p>
          <p className="text-xs text-gray-500 truncate">{email.from_email}</p>
        </div>
        <span className="text-xs text-gray-400 flex-shrink-0">{timeAgo(email.received_at)}</span>
      </div>

      {/* Objet */}
      <p className="text-sm font-medium text-gray-900 truncate mb-1.5">
        {email.subject}
      </p>

      {/* Aperçu du brouillon */}
      {email.draft_preview && (
        <p className="text-xs text-gray-500 line-clamp-2 leading-relaxed">
          {email.draft_preview}
        </p>
      )}
    </button>
  )
}

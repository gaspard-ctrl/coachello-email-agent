import { useState, useRef } from 'react'

interface Props {
  onClose: () => void
  onSent: () => void
  initialTo?: string[]
  initialCc?: string[]
  initialSubject?: string
  initialBody?: string
}

function EmailTagInput({ emails, setEmails, placeholder }: {
  emails: string[];
  setEmails: (v: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState('')

  const addEmail = (value: string) => {
    const trimmed = value.trim().replace(/,+$/, '').trim()
    if (trimmed && !emails.includes(trimmed)) {
      setEmails([...emails, trimmed])
    }
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && input.trim()) {
      e.preventDefault()
      addEmail(input)
    }
    if (e.key === 'Backspace' && !input && emails.length > 0) {
      setEmails(emails.slice(0, -1))
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text')
    const parts = pasted.split(/[,;\s]+/).filter(Boolean)
    const newEmails = [...emails]
    parts.forEach(p => {
      const trimmed = p.trim()
      if (trimmed && !newEmails.includes(trimmed)) newEmails.push(trimmed)
    })
    setEmails(newEmails)
  }

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1 px-2 py-1.5 border border-[#D8D0C5] rounded-xl focus-within:ring-2 focus-within:ring-[#E8452A] bg-white min-h-[38px]">
      {emails.map((email, i) => (
        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#F5F0EB] rounded-full text-xs text-[#555]">
          {email}
          <button
            onClick={() => setEmails(emails.filter((_, j) => j !== i))}
            className="text-[#aaa] hover:text-[#E8452A] leading-none"
          >&times;</button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => { if (input.trim()) addEmail(input) }}
        placeholder={emails.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] text-sm outline-none bg-transparent py-0.5"
      />
    </div>
  )
}

export default function ComposeEmail({ onClose, onSent, initialTo, initialCc, initialSubject, initialBody }: Props) {
  const [toEmails, setToEmails]   = useState<string[]>(initialTo ?? [])
  const [ccEmails, setCcEmails]   = useState<string[]>(initialCc ?? [])
  const [subject, setSubject]     = useState(initialSubject ?? '')
  const [body, setBody]           = useState(initialBody ?? '')
  const [instructions, setInstructions] = useState('')
  const [showInstructions, setShowInstructions] = useState(false)
  const [loading, setLoading]     = useState(false)
  const [drafting, setDrafting]   = useState(false)
  const [feedback, setFeedback]   = useState<string | null>(null)
  const [outgoingFiles, setOutgoingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Demander à Claude de rédiger le mail
  const handleDraft = async () => {
    if (toEmails.length === 0) return setFeedback('Destinataire requis')
    if (!instructions.trim()) return setFeedback('Donne des instructions à Claude')

    setDrafting(true)
    setFeedback(null)
    try {
      const res = await fetch('/api/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft',
          to: toEmails.join(', '),
          subject: subject.trim() || undefined,
          instructions: instructions.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Erreur')

      setBody(data.body)
      if (data.subject && !subject.trim()) setSubject(data.subject)
      setFeedback('Brouillon généré par Claude ✓')
      setTimeout(() => setFeedback(null), 3000)
    } catch (err) {
      setFeedback(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
    }
    setDrafting(false)
  }

  // Envoyer l'email
  const handleSend = async () => {
    if (toEmails.length === 0) return setFeedback('Destinataire requis')
    if (!subject.trim()) return setFeedback('Objet requis')
    if (!body.trim()) return setFeedback('Contenu requis')

    setLoading(true)
    setFeedback(null)
    try {
      const attachments = outgoingFiles.length > 0
        ? await convertFilesToBase64(outgoingFiles)
        : undefined

      const res = await fetch('/api/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          to: toEmails.join(', '),
          cc: ccEmails.length > 0 ? ccEmails.join(', ') : undefined,
          subject: subject.trim(),
          content: body.trim(),
          attachments,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Erreur')

      setFeedback('Email envoyé ✓')
      setTimeout(onSent, 1200)
    } catch (err) {
      setFeedback(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
      setLoading(false)
    }
  }

  // Sauvegarder en brouillon Gmail
  const handleSaveDraft = async () => {
    if (toEmails.length === 0) return setFeedback('Destinataire requis')
    if (!subject.trim()) return setFeedback('Objet requis')
    if (!body.trim()) return setFeedback('Contenu requis')

    setLoading(true)
    setFeedback(null)
    try {
      const attachments = outgoingFiles.length > 0
        ? await convertFilesToBase64(outgoingFiles)
        : undefined

      const res = await fetch('/api/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft-gmail',
          to: toEmails.join(', '),
          cc: ccEmails.length > 0 ? ccEmails.join(', ') : undefined,
          subject: subject.trim(),
          content: body.trim(),
          attachments,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Erreur')

      setFeedback('Brouillon enregistré dans Gmail ✓')
      setTimeout(onSent, 1200)
    } catch (err) {
      setFeedback(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
      setLoading(false)
    }
  }

  const totalSize = outgoingFiles.reduce((s, f) => s + f.size, 0)

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[#EDE8E0]">
        <h2 className="text-lg font-bold text-[#333]">Nouveau mail</h2>
        <button onClick={onClose} className="text-[#aaa] hover:text-[#E8452A] text-xl leading-none">&times;</button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto p-5 space-y-3">
        {/* To */}
        <div>
          <label className="text-xs font-semibold text-[#888] uppercase tracking-wider">À</label>
          <EmailTagInput emails={toEmails} setEmails={setToEmails} placeholder="email@exemple.com" />
        </div>

        {/* CC */}
        <div>
          <label className="text-xs font-semibold text-[#888] uppercase tracking-wider">Cc</label>
          <EmailTagInput emails={ccEmails} setEmails={setCcEmails} placeholder="cc@exemple.com (optionnel)" />
        </div>

        {/* Subject */}
        <div>
          <label className="text-xs font-semibold text-[#888] uppercase tracking-wider">Objet</label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Objet du mail"
            className="w-full mt-1 px-3 py-2 text-sm border border-[#D8D0C5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#E8452A] bg-white"
          />
        </div>

        {/* Instructions Claude */}
        <div>
          <button
            onClick={() => setShowInstructions(!showInstructions)}
            className="flex items-center gap-1.5 text-xs font-semibold text-[#E8452A] hover:text-[#c33] transition-colors"
          >
            <span>{showInstructions ? '▾' : '▸'}</span>
            Donner des instructions à Claude
          </button>

          {showInstructions && (
            <div className="mt-2 space-y-2">
              <textarea
                value={instructions}
                onChange={e => setInstructions(e.target.value)}
                placeholder="Ex : Rédige un email pour informer ce coach que sa session du 15 avril est confirmée. Ton chaleureux et professionnel."
                className="w-full text-sm text-[#444] leading-relaxed border border-[#E8452A]/30 rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#E8452A] min-h-[80px] bg-[#FFF8F6]"
              />
              <button
                onClick={handleDraft}
                disabled={drafting}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-[#E8452A] hover:bg-[#d33] rounded-lg transition-colors disabled:opacity-40"
              >
                {drafting ? (
                  <span className="flex items-center gap-1.5">
                    <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                    Claude rédige...
                  </span>
                ) : 'Générer le brouillon'}
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        <div>
          <label className="text-xs font-semibold text-[#888] uppercase tracking-wider">Message</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Contenu de l'email..."
            className="w-full mt-1 text-sm text-[#444] leading-relaxed border border-[#D8D0C5] rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#E8452A] min-h-[200px] bg-white"
          />
        </div>

        {/* Attachments */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => {
              if (e.target.files) setOutgoingFiles(prev => [...prev, ...Array.from(e.target.files!)])
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-[#888] hover:text-[#E8452A] flex items-center gap-1 transition-colors"
          >
            📎 Joindre un fichier
          </button>
          {outgoingFiles.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#F5F0EB] rounded-full text-xs text-[#555]">
              {f.name}
              <button onClick={() => setOutgoingFiles(prev => prev.filter((_, j) => j !== i))} className="text-[#aaa] hover:text-[#E8452A]">&times;</button>
            </span>
          ))}
          {totalSize > 4 * 1024 * 1024 && (
            <span className="text-xs text-[#E8452A] font-semibold">Taille totale &gt; 4 Mo</span>
          )}
        </div>
      </div>

      {/* Footer / Actions */}
      <div className="px-5 py-3 border-t border-[#EDE8E0] flex items-center justify-between">
        <div className="flex-1">
          {feedback && (
            <span className={`text-xs font-semibold ${feedback.startsWith('Erreur') ? 'text-[#E8452A]' : 'text-emerald-600'}`}>
              {feedback}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-semibold text-[#888] hover:text-[#333] transition-colors"
          >
            Annuler
          </button>
          <button
            onClick={handleSaveDraft}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-semibold text-[#E8452A] border border-[#E8452A] hover:bg-[#FEE9E5] rounded-lg transition-colors disabled:opacity-40"
          >
            Brouillon Gmail
          </button>
          <button
            onClick={handleSend}
            disabled={loading}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-[#E8452A] hover:bg-[#d33] rounded-lg transition-colors disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                Envoi...
              </span>
            ) : 'Envoyer'}
          </button>
        </div>
      </div>
    </div>
  )
}

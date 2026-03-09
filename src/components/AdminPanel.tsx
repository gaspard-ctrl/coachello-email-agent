import { useState, useEffect } from 'react'
import { Example, Rule, Classification, CLASSIFICATION_CONFIG } from '../types'

type Tab = 'guide' | 'rules'

const CLASSIFICATIONS: Classification[] = ['URGENT', 'IMPORTANT', 'NORMAL', 'FAIBLE']

export default function AdminPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('guide')

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Administration de l'agent</h1>

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {(['guide', 'rules'] as Tab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-indigo-600 text-indigo-700 bg-indigo-50'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {tab === 'guide' ? '📄 Guide & Exemples' : '⚙️ Règles de classification'}
          </button>
        ))}
      </div>

      {activeTab === 'guide' && <GuideAndExamplesTab />}
      {activeTab === 'rules' && <RulesTab />}
    </div>
  )
}

// ── Guide + Exemples ───────────────────────────────────────────
function GuideAndExamplesTab() {
  const [guide, setGuide]         = useState<string>('')
  const [filename, setFilename]   = useState<string>('')
  const [saving, setSaving]       = useState(false)
  const [feedback, setFeedback]   = useState<string | null>(null)
  const [editing, setEditing]     = useState(true)

  const [examples, setExamples]   = useState<Example[]>([])
  const [showForm, setShowForm]   = useState(false)
  const [exForm, setExForm]       = useState({
    email_subject: '', email_from: '', email_body: '',
    ideal_response: '', classification: 'NORMAL' as Classification, notes: '',
  })
  const [exSaving, setExSaving]   = useState(false)
  const [exFeedback, setExFeedback] = useState<string | null>(null)

  // ── Chargement ──
  useEffect(() => {
    fetch('/api/guide')
      .then(r => r.json())
      .then(d => {
        setGuide(d.guide?.content ?? '')
        setFilename(d.guide?.filename ?? '')
      })
    loadExamples()
  }, [])

  const loadExamples = () =>
    fetch('/api/examples').then(r => r.json()).then(d => setExamples(d.examples ?? []))

  // ── Guide : upload fichier ──
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    const form = new FormData()
    form.append('file', file)
    const res  = await fetch('/api/guide', { method: 'POST', body: form })
    const data = await res.json()
    if (res.ok) {
      // Recharger le contenu complet depuis l'API (pas juste le preview)
      const full = await fetch('/api/guide').then(r => r.json())
      setGuide(full.guide?.content ?? data.preview)
      setFilename(data.filename)
      setFeedback(`"${data.filename}" importé (${data.length} caractères)`)
      setEditing(false)
    } else {
      setFeedback(`Erreur : ${data.error}`)
    }
    setSaving(false)
    e.target.value = ''
  }

  // ── Guide : sauvegarder le texte édité ──
  const handleSaveText = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: guide, filename: filename || 'guide_manuel.txt' }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok) {
        setFeedback('Guide sauvegardé ✓')
        setEditing(false)
      } else {
        setFeedback(`Erreur ${res.status} : ${data?.error ?? 'inconnu'}`)
      }
    } catch (err) {
      setFeedback(`Erreur réseau : ${err instanceof Error ? err.message : 'inconnu'}`)
    }
    setSaving(false)
  }

  // ── Guide : télécharger ──
  const handleDownload = () => {
    const blob = new Blob([guide], { type: 'text/plain;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = filename || 'guide.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Exemples : ajouter ──
  const handleAddExample = async () => {
    if (!exForm.email_body || !exForm.ideal_response) {
      setExFeedback('Email et réponse idéale sont requis')
      return
    }
    setExSaving(true)
    const res = await fetch('/api/examples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exForm),
    })
    if (res.ok) {
      setExFeedback('Exemple ajouté ✓')
      setExForm({ email_subject: '', email_from: '', email_body: '', ideal_response: '', classification: 'NORMAL', notes: '' })
      setShowForm(false)
      loadExamples()
    } else {
      setExFeedback('Erreur')
    }
    setExSaving(false)
  }

  // ── Exemples : supprimer ──
  const handleDeleteExample = async (id: string) => {
    await fetch(`/api/examples?id=${id}`, { method: 'DELETE' })
    loadExamples()
  }

  return (
    <div className="space-y-6">

      {/* ════ Section Guide ════ */}
      <div className="card overflow-hidden">

        {/* En-tête guide */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900">Guide de réponse</h2>
            {filename && (
              <p className="text-xs text-gray-400 mt-0.5">{filename}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {guide && !editing && (
              <button onClick={handleDownload} className="btn-ghost text-sm">
                Télécharger
              </button>
            )}
            {guide && (
              <button
                onClick={() => { setEditing(e => !e); setFeedback(null) }}
                className="btn-ghost text-sm"
              >
                {editing ? 'Aperçu' : 'Modifier'}
              </button>
            )}
            {editing && (
              <label className="btn-ghost text-sm cursor-pointer">
                Importer fichier
                <input
                  type="file"
                  accept=".docx,.txt,.md"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            )}
          </div>
        </div>

        {/* Corps du guide */}
        {editing ? (
          <div className="p-6 space-y-4">
            <textarea
              value={guide}
              onChange={e => setGuide(e.target.value)}
              rows={18}
              className="w-full text-sm text-gray-700 border border-gray-200 rounded-lg p-4 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono leading-relaxed"
              placeholder="Décrivez ici le ton, les formules de politesse, les cas fréquents, ce qu'il ne faut jamais dire..."
            />
            <div className="flex items-center justify-between">
              {feedback
                ? <span className={`text-sm px-3 py-1.5 rounded-lg ${feedback.startsWith('Erreur') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>{feedback}</span>
                : <span />
              }
              <button onClick={handleSaveText} disabled={saving} className="btn-primary text-sm">
                {saving ? 'Sauvegarde...' : 'Sauvegarder'}
              </button>
            </div>
          </div>
        ) : (
          <div className="px-8 py-6 max-h-[28rem] overflow-y-auto">
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed font-serif">
              {guide}
            </div>
          </div>
        )}

        {/* Feedback upload */}
        {feedback && !editing && (
          <div className="px-6 pb-4">
            <span className="text-sm text-green-700 bg-green-50 px-3 py-1.5 rounded-lg">{feedback}</span>
          </div>
        )}
      </div>

      {/* ════ Section Exemples ════ */}
      <div className="card overflow-hidden">

        {/* En-tête exemples */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900">Exemples de réponses</h2>
            <p className="text-xs text-gray-400 mt-0.5">{examples.length} exemple{examples.length !== 1 ? 's' : ''} — utilisés comme référence par Claude</p>
          </div>
          <button
            onClick={() => { setShowForm(f => !f); setExFeedback(null) }}
            className="btn-primary text-sm"
          >
            {showForm ? 'Annuler' : '+ Ajouter'}
          </button>
        </div>

        {/* Formulaire d'ajout */}
        {showForm && (
          <div className="p-6 border-b border-gray-100 bg-gray-50 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Objet de l'email</label>
                <input
                  value={exForm.email_subject}
                  onChange={e => setExForm(f => ({ ...f, email_subject: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  placeholder="Objet..."
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Expéditeur</label>
                <input
                  value={exForm.email_from}
                  onChange={e => setExForm(f => ({ ...f, email_from: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  placeholder="email@example.com"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email reçu *</label>
                <textarea
                  value={exForm.email_body}
                  onChange={e => setExForm(f => ({ ...f, email_body: e.target.value }))}
                  rows={5}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  placeholder="Copiez ici l'email reçu..."
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Réponse idéale *</label>
                <textarea
                  value={exForm.ideal_response}
                  onChange={e => setExForm(f => ({ ...f, ideal_response: e.target.value }))}
                  rows={5}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  placeholder="Copiez ici la réponse parfaite..."
                />
              </div>
            </div>

            <div className="flex items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Classification</label>
                <select
                  value={exForm.classification}
                  onChange={e => setExForm(f => ({ ...f, classification: e.target.value as Classification }))}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                >
                  {CLASSIFICATIONS.map(c => (
                    <option key={c} value={c}>{CLASSIFICATION_CONFIG[c].label}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optionnel)</label>
                <input
                  value={exForm.notes}
                  onChange={e => setExForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  placeholder="Pourquoi cet exemple est représentatif..."
                />
              </div>
              <div className="flex items-center gap-2">
                {exFeedback && <span className="text-sm text-green-700">{exFeedback}</span>}
                <button onClick={handleAddExample} disabled={exSaving} className="btn-primary text-sm">
                  {exSaving ? 'Ajout...' : 'Ajouter'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Liste des exemples */}
        {examples.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">
            Aucun exemple — ajoutez des emails représentatifs pour améliorer les réponses de Claude.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {examples.map(ex => {
              const conf = CLASSIFICATION_CONFIG[ex.classification]
              return (
                <div key={ex.id} className="flex items-start gap-4 px-6 py-4 hover:bg-gray-50 transition-colors">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${conf.badge}`}>
                    {conf.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    {ex.email_subject && (
                      <p className="text-sm font-medium text-gray-800 truncate">{ex.email_subject}</p>
                    )}
                    <p className="text-xs text-gray-500 truncate mt-0.5">{ex.email_body_preview}</p>
                  </div>
                  <button
                    onClick={() => handleDeleteExample(ex.id)}
                    className="text-xs text-red-400 hover:text-red-600 flex-shrink-0 transition-colors"
                  >
                    Supprimer
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Onglet Règles ─────────────────────────────────────────────
function RulesTab() {
  const [rules, setRules]   = useState<Rule[]>([])
  const [form, setForm]     = useState({ rule_type: 'sender', value: '', classification: 'URGENT' as Classification })
  const [saving, setSaving] = useState(false)

  const load = () => fetch('/api/rules').then(r => r.json()).then(d => setRules(d.rules ?? []))
  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    if (!form.value) return
    setSaving(true)
    await fetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setForm(f => ({ ...f, value: '' }))
    load()
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/rules?id=${id}`, { method: 'DELETE' })
    load()
  }

  const RULE_TYPES = [
    { value: 'sender',          label: 'Expéditeur exact (email)' },
    { value: 'domain',          label: 'Domaine (@entreprise.com)' },
    { value: 'keyword',         label: 'Mot-clé dans le corps' },
    { value: 'subject_keyword', label: "Mot-clé dans l'objet" },
  ]

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Ajouter une règle</h2>
        <div className="flex items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Type</label>
            <select
              value={form.rule_type}
              onChange={e => setForm(f => ({ ...f, rule_type: e.target.value }))}
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {RULE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-700 mb-1">Valeur</label>
            <input
              value={form.value}
              onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={
                form.rule_type === 'sender' ? 'client@example.com' :
                form.rule_type === 'domain' ? 'example.com' : 'facture'
              }
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">→ Classification</label>
            <select
              value={form.classification}
              onChange={e => setForm(f => ({ ...f, classification: e.target.value as Classification }))}
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {CLASSIFICATIONS.map(c => <option key={c} value={c}>{CLASSIFICATION_CONFIG[c].label}</option>)}
            </select>
          </div>
          <button onClick={handleAdd} disabled={saving || !form.value} className="btn-primary text-sm">
            Ajouter
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">{rules.length} règle{rules.length !== 1 ? 's' : ''} active{rules.length !== 1 ? 's' : ''}</h3>
        </div>
        {rules.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">
            Aucune règle définie.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {rules.map(rule => {
              const conf = CLASSIFICATION_CONFIG[rule.classification]
              return (
                <div key={rule.id} className="flex items-center gap-4 px-6 py-3 hover:bg-gray-50 transition-colors">
                  <span className="text-xs text-gray-500 font-mono bg-gray-100 px-2 py-0.5 rounded">{rule.rule_type}</span>
                  <span className="text-sm font-medium flex-1">"{rule.value}"</span>
                  <span className="text-gray-300">→</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${conf.badge}`}>{conf.label}</span>
                  <button onClick={() => handleDelete(rule.id)} className="text-xs text-red-400 hover:text-red-600 transition-colors">
                    Supprimer
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import Dashboard from './components/Dashboard'
import AdminPanel from './components/AdminPanel'

type View = 'dashboard' | 'admin'

const PASSWORD = import.meta.env.VITE_APP_PASSWORD as string

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [input, setInput]   = useState('')
  const [error, setError]   = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (input === PASSWORD) {
      sessionStorage.setItem('auth', '1')
      onLogin()
    } else {
      setError(true)
      setInput('')
    }
  }

  return (
    <div className="min-h-screen bg-[#F5F0EA] flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-lg px-10 py-10 w-full max-w-sm border border-[#EDE8E0]">
        <div className="text-center mb-8">
          <img src="/logo-coachello.png" alt="Coachello" className="h-8 mx-auto mb-2" />
          <p className="text-xs text-[#aaa] font-semibold uppercase tracking-widest">Agent Email</p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="password"
            value={input}
            onChange={e => { setInput(e.target.value); setError(false) }}
            placeholder="Mot de passe"
            autoFocus
            className={`w-full border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8452A] ${
              error ? 'border-red-400 bg-red-50' : 'border-[#D8D0C5] bg-white'
            }`}
          />
          {error && <p className="text-xs text-red-500 -mt-2">Mot de passe incorrect</p>}
          <button type="submit" className="btn-primary py-3 text-sm font-semibold">
            Accéder
          </button>
        </form>
      </div>
    </div>
  )
}

export default function App() {
  const [view, setView]       = useState<View>('dashboard')
  const [authed, setAuthed]   = useState(() => sessionStorage.getItem('auth') === '1')
  const [refreshing, setRefreshing] = useState(false)

  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />

  const triggerRefresh = () => {
    setRefreshing(true)
    window.dispatchEvent(new CustomEvent('dashboard:refresh'))
    setTimeout(() => setRefreshing(false), 1500)
  }

  return (
    <div className="min-h-screen bg-[#F5F0EA]">
      {/* ── Header ── */}
      <header className="bg-[#F5F0EA] border-b border-[#E8E2D9] sticky top-0 z-40">
        <div className="px-6 h-[42px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo-coachello.png" alt="Coachello" className="h-5" />
            <span className="text-[#D8D0C5] select-none text-xs">|</span>
            <span className="text-[10px] text-[#aaa] font-semibold uppercase tracking-widest">Agent Email</span>
          </div>

          <div className="flex items-center gap-2">
            {view === 'dashboard' && (
              <button
                onClick={triggerRefresh}
                disabled={refreshing}
                title="Actualiser l'inbox"
                className="w-7 h-7 flex items-center justify-center rounded-full text-[#999] hover:text-[#E8452A] hover:bg-[#EDE8E0] transition-colors disabled:opacity-50"
              >
                <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}

            <nav className="flex items-center gap-1 bg-[#EDE8E0] rounded-full p-0.5">
              <button
                onClick={() => setView('dashboard')}
                className={`px-3 py-1 rounded-full text-[12px] font-semibold transition-colors ${
                  view === 'dashboard'
                    ? 'bg-white text-[#1a1a1a] shadow-sm'
                    : 'text-[#999] hover:text-[#555]'
                }`}
              >
                Dashboard
              </button>
              <button
                onClick={() => setView('admin')}
                className={`px-3 py-1 rounded-full text-[12px] font-semibold transition-colors ${
                  view === 'admin'
                    ? 'bg-white text-[#1a1a1a] shadow-sm'
                    : 'text-[#999] hover:text-[#555]'
                }`}
              >
                Administration
              </button>
            </nav>
          </div>
        </div>
      </header>

      {/* ── Contenu ── */}
      <main className={view === 'dashboard'
        ? 'px-3 py-3'
        : 'max-w-5xl mx-auto px-6 py-6'
      }>
        {view === 'dashboard' ? <Dashboard /> : <AdminPanel />}
      </main>
    </div>
  )
}

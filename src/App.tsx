import { useState } from 'react'
import Dashboard from './components/Dashboard'
import AdminPanel from './components/AdminPanel'

type View = 'dashboard' | 'admin'

export default function App() {
  const [view, setView] = useState<View>('dashboard')

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo texte */}
            <span className="text-xl font-bold text-indigo-700 tracking-tight">Coachello</span>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-500 font-medium">Agent Email</span>
          </div>

          <nav className="flex items-center gap-1">
            <button
              onClick={() => setView('dashboard')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                view === 'dashboard'
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
              }`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setView('admin')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                view === 'admin'
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
              }`}
            >
              Administration
            </button>
          </nav>
        </div>
      </header>

      {/* ── Contenu ── */}
      <main className={view === 'dashboard'
        ? 'px-4 sm:px-6 py-4'
        : 'max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6'
      }>
        {view === 'dashboard' ? <Dashboard /> : <AdminPanel />}
      </main>
    </div>
  )
}

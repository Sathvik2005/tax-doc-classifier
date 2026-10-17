import { useState } from 'react'
import ClassifyPage from './pages/ClassifyPage'
import CatalogPage from './pages/CatalogPage'
import EvaluationPage from './pages/EvaluationPage'
import SettingsPage from './pages/SettingsPage'

const NAV = [
  { id: 'classify', label: 'Classify', icon: '⌁' },
  { id: 'catalog', label: 'Catalog', icon: '☰' },
  { id: 'evaluation', label: 'Evaluation', icon: '✓' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
] as const

type PageId = (typeof NAV)[number]['id']

export default function App() {
  const [page, setPage] = useState<PageId>('classify')

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">tax-doc-classifier</div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {page === 'classify' && <ClassifyPage />}
        {page === 'catalog' && <CatalogPage />}
        {page === 'evaluation' && <EvaluationPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

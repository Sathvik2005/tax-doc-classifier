import { useEffect, useMemo, useState } from 'react'
import type { CriteriaEntry } from '../types'

export default function CatalogPage() {
  const [forms, setForms] = useState<CriteriaEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    fetch('/api/catalog')
      .then((res) => res.json())
      .then((data) => setForms(data.forms))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const filtered = useMemo(() => {
    if (!forms) return []
    const q = query.trim().toLowerCase()
    if (!q) return forms
    return forms.filter((f) => f.id.toLowerCase().includes(q) || f.title.toLowerCase().includes(q) || f.label.toLowerCase().includes(q))
  }, [forms, query])

  return (
    <div className="page-main">
      <h1>Catalog</h1>
      <p className="subtitle">Forms known to the classifier, generated from {'`'}data/criteria.json{'`'}.</p>

      {error && <div className="error">{error}</div>}

      <input
        className="search"
        placeholder="Search by id, label, or title…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {forms && <div className="summary">{filtered.length} / {forms.length} forms</div>}

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Label</th>
            <th>Title</th>
            <th>Pages</th>
            <th>Parent</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((f) => (
            <tr key={f.id}>
              <td><code>{f.id}</code></td>
              <td>{f.label}</td>
              <td>{f.title}</td>
              <td>{f.pageCount}</td>
              <td>{f.parent ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

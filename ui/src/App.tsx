import { useState } from 'react'

type PageResult = {
  page: number
  skipped: boolean
  reason?: string
  form?: string
  kind?: string
  formConfidence?: number
  kindConfidence?: number
  gated?: boolean
  calls?: number
  inputTokens?: number
}

type ApiResponse = { pageCount: number; results: PageResult[] } | { error: string }

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<PageResult[] | null>(null)

  async function classify() {
    if (!file) return
    setLoading(true)
    setError(null)
    setResults(null)
    try {
      const res = await fetch('/api/classify', { method: 'POST', body: file })
      const data = (await res.json()) as ApiResponse
      if (!res.ok || 'error' in data) throw new Error('error' in data ? data.error : `HTTP ${res.status}`)
      setResults(data.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const totalCost = results?.reduce((n, r) => n + (r.inputTokens ?? 0), 0) ?? 0
  const gatedCount = results?.filter((r) => r.gated).length ?? 0

  return (
    <div className="app">
      <h1>tax-doc-classifier</h1>
      <p className="subtitle">Upload a tax PDF, classify every page against {'{'}form, kind{'}'} via Jev.</p>

      <div className="dropzone">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button onClick={classify} disabled={!file || loading}>
          {loading ? 'Classifying…' : 'Classify'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {results && (
        <>
          <div className="summary">
            {results.length} pages · {gatedCount} gated (confident) · {results.length - gatedCount} need review ·{' '}
            ~{(totalCost * 0.042 / 1e6).toFixed(4)} USD
          </div>
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Form</th>
                <th>Kind</th>
                <th>Confidence</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.page}>
                  <td>{r.page}</td>
                  <td>{r.skipped ? '—' : r.form}</td>
                  <td>{r.skipped ? r.reason : r.kind}</td>
                  <td>
                    {!r.skipped && r.formConfidence !== undefined && (
                      <>
                        <span className="confidence-bar">
                          <span
                            className="confidence-fill"
                            style={{ width: `${Math.round(r.formConfidence * 100)}%` }}
                          />
                        </span>
                        {(r.formConfidence * 100).toFixed(0)}%
                      </>
                    )}
                  </td>
                  <td>
                    {r.skipped ? (
                      <span className="badge skipped">skipped</span>
                    ) : r.gated ? (
                      <span className="badge gated">gated</span>
                    ) : (
                      <span className="badge not-gated">review</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

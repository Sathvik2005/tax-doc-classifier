import { useState } from 'react'
import type { PageResult } from '../types'

type ApiResponse = { pageCount: number; results: PageResult[] } | { error: string }

function topProbs(probs: Record<string, number> | undefined, n = 5): [string, number][] {
  if (!probs) return []
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

function Inspector({ result, onClose }: { result: PageResult; onClose: () => void }) {
  return (
    <div className="inspector">
      <div className="inspector-header">
        <h3>Page {result.page}</h3>
        <button className="ghost" onClick={onClose}>close</button>
      </div>

      {result.preview && (
        <img className="inspector-preview" src={result.preview} alt={`page ${result.page} preview`} />
      )}

      {result.skipped ? (
        <p className="inspector-note">Skipped — {result.reason}</p>
      ) : (
        <>
          <div className="inspector-row">
            <span className="label">Form</span>
            <span>{result.form}</span>
          </div>
          <div className="inspector-row">
            <span className="label">Kind</span>
            <span>{result.kind}</span>
          </div>
          <div className="inspector-row">
            <span className="label">Gate</span>
            <span>{result.gated ? 'passed (confident)' : 'needs review'}</span>
          </div>
          <div className="inspector-row">
            <span className="label">Calls / tokens</span>
            <span>{result.calls} · {result.inputTokens}</span>
          </div>

          <h4>Top form candidates</h4>
          <ul className="prob-list">
            {topProbs(result.probabilities?.form).map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                <span className="confidence-bar">
                  <span className="confidence-fill" style={{ width: `${Math.round(v * 100)}%` }} />
                </span>
                <span>{(v * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>

          <h4>Top kind candidates</h4>
          <ul className="prob-list">
            {topProbs(result.probabilities?.kind).map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                <span className="confidence-bar">
                  <span className="confidence-fill" style={{ width: `${Math.round(v * 100)}%` }} />
                </span>
                <span>{(v * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {result.text && (
        <>
          <h4>Extracted text {result.ocr && <span className="badge ocr">OCR</span>}</h4>
          <pre className="inspector-text">{result.text}</pre>
        </>
      )}
    </div>
  )
}

export default function ClassifyPage() {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<PageResult[] | null>(null)
  const [selected, setSelected] = useState<PageResult | null>(null)

  async function classify() {
    if (!file) return
    setLoading(true)
    setError(null)
    setResults(null)
    setSelected(null)
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
    <div className="page-layout">
      <div className="page-main">
        <h1>Classify</h1>
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
                  <tr key={r.page} className="clickable" onClick={() => setSelected(r)}>
                    <td>{r.page}</td>
                    <td>
                      {r.skipped ? '—' : r.form}
                      {r.ocr && <span className="badge ocr" title="no text layer — classified from OCR'd text"> OCR</span>}
                    </td>
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

      {selected && <Inspector result={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

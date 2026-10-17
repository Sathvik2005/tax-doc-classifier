import { useState } from 'react'
import type { PageResult } from '../types'

type UploadResponse = { jobId: string; pageCount: number } | { error: string }

function topProbs(probs: Record<string, number> | undefined, n = 5): [string, number][] {
  if (!probs) return []
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

function Inspector({ jobId, result, onClose }: { jobId: string; result: PageResult; onClose: () => void }) {
  return (
    <div className="inspector">
      <div className="inspector-header">
        <h3>Page {result.page}</h3>
        <button className="ghost" onClick={onClose}>close</button>
      </div>

      <img
        className="inspector-preview"
        src={`/api/classify/${jobId}/preview/${result.page}`}
        alt={`page ${result.page} preview`}
      />

      {result.skipped ? (
        <p className="inspector-note">
          {result.reason === 'error' ? `Error — ${result.error}` : `Skipped — ${result.reason}`}
        </p>
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
            <span>
              {result.gated ? 'passed (confident)' : 'needs review'}
              {result.ocrUncertain && ' — OCR inconclusive, forced to review'}
            </span>
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
  const [jobId, setJobId] = useState<string | null>(null)
  const [results, setResults] = useState<PageResult[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)

  async function classify() {
    if (!file) return
    setLoading(true)
    setError(null)
    setResults(null)
    setSelected(null)
    setJobId(null)
    try {
      const uploadRes = await fetch('/api/classify', { method: 'POST', body: file })
      const uploaded = (await uploadRes.json()) as UploadResponse
      if (!uploadRes.ok || 'error' in uploaded) throw new Error('error' in uploaded ? uploaded.error : `HTTP ${uploadRes.status}`)

      setJobId(uploaded.jobId)
      setResults(Array.from({ length: uploaded.pageCount }, (_, i) => ({ page: i + 1, pending: true, skipped: false })))

      const streamRes = await fetch(`/api/classify/${uploaded.jobId}/stream`)
      if (!streamRes.ok || !streamRes.body) throw new Error(`stream failed: HTTP ${streamRes.status}`)

      const reader = streamRes.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let newlineAt: number
        while ((newlineAt = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, newlineAt)
          buf = buf.slice(newlineAt + 1)
          if (!line.trim()) continue
          const obj = JSON.parse(line) as (PageResult & { done?: false }) | { done: true; budgetExceeded?: boolean; error?: string }
          if ('done' in obj && obj.done) {
            if (obj.budgetExceeded) setError('Run stopped: per-run cost budget exceeded (see Settings).')
            else if (obj.error) setError(obj.error)
            continue
          }
          const page = obj as PageResult
          setResults((prev) => {
            if (!prev) return prev
            const next = [...prev]
            next[page.page - 1] = page
            return next
          })
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const doneResults = results?.filter((r) => !r.pending) ?? []
  const totalCost = doneResults.reduce((n, r) => n + (r.inputTokens ?? 0), 0)
  const gatedCount = doneResults.filter((r) => r.gated).length
  const selectedResult = selected !== null ? results?.[selected - 1] : undefined

  return (
    <div className="page-layout">
      <div className="page-main">
        <h1>Classify</h1>
        <p className="subtitle">Upload a tax PDF, classify every page against {'{'}form, kind{'}'} via Jev. Handles large (500+ page) documents via streamed, concurrent page processing.</p>

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
              {doneResults.length} / {results.length} pages processed · {gatedCount} gated (confident) ·{' '}
              {doneResults.length - gatedCount} need review · ~{(totalCost * 0.042 / 1e6).toFixed(4)} USD
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
                  <tr key={r.page} className="clickable" onClick={() => setSelected(r.page)}>
                    <td>{r.page}</td>
                    <td>
                      {r.pending ? '…' : r.skipped ? '—' : r.form}
                      {r.ocr && <span className="badge ocr" title="no text layer — classified from OCR'd text"> OCR</span>}
                      {r.ocrUncertain && (
                        <span className="badge ocr-uncertain" title="page couldn't be confirmed blank — OCR failed or couldn't run, forced to review">
                          {' '}needs review
                        </span>
                      )}
                    </td>
                    <td>{r.pending ? '' : r.skipped ? (r.reason === 'error' ? 'error' : r.reason) : r.kind}</td>
                    <td>
                      {!r.pending && !r.skipped && r.formConfidence !== undefined && (
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
                      {r.pending ? (
                        <span className="badge skipped">pending</span>
                      ) : r.skipped ? (
                        <span className="badge skipped">{r.reason === 'error' ? 'error' : 'skipped'}</span>
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

      {jobId && selectedResult && !selectedResult.pending && (
        <Inspector jobId={jobId} result={selectedResult} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

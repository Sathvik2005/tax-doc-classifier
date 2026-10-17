import { useEffect, useState } from 'react'
import type { EvalRunSummary } from '../types'

export default function EvaluationPage() {
  const [runs, setRuns] = useState<EvalRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<unknown>(null)

  useEffect(() => {
    fetch('/api/eval-results')
      .then((res) => res.json())
      .then((data) => setRuns(data.results))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  function openRun(file: string) {
    setSelected(file)
    setDetail(null)
    fetch(`/api/eval-results?file=${encodeURIComponent(file)}`)
      .then((res) => res.json())
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        <h1>Evaluation</h1>
        <p className="subtitle">Strict-rate runs from {'`'}pnpm eval{'`'}, read from {'`'}eval/results{'`'}.</p>

        {error && <div className="error">{error}</div>}

        {runs && runs.length === 0 && <p className="inspector-note">No eval runs found. Run {'`'}pnpm eval{'`'} to generate one.</p>}

        {runs && runs.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Corpus</th>
                <th>Gate</th>
                <th>Strict rate</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const summary = r.summary as { strictRate?: number } | undefined
                return (
                  <tr key={r.file} className="clickable" onClick={() => openRun(r.file)}>
                    <td>{r.file}</td>
                    <td>{String(r.corpus ?? '—')}</td>
                    <td>{String(r.gate ?? '—')}</td>
                    <td>{summary?.strictRate !== undefined ? `${(summary.strictRate * 100).toFixed(1)}%` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="inspector">
          <div className="inspector-header">
            <h3>{selected}</h3>
            <button className="ghost" onClick={() => setSelected(null)}>close</button>
          </div>
          <pre className="inspector-text">{detail ? JSON.stringify(detail, null, 2) : 'loading…'}</pre>
        </div>
      )}
    </div>
  )
}

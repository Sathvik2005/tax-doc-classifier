import { useEffect, useState } from 'react'
import type { AppConfig } from '../types'

export default function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then(setConfig)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <div className="page-main">
      <h1>Settings</h1>
      <p className="subtitle">Live server configuration (read-only — change via server env/constants).</p>

      {error && <div className="error">{error}</div>}

      {config && (
        <div className="settings-grid">
          <div className="inspector-row"><span className="label">Model</span><span>{config.model}</span></div>
          <div className="inspector-row"><span className="label">Confidence gate</span><span>{config.gate}</span></div>
          <div className="inspector-row"><span className="label">Page image DPI</span><span>{config.pageImageDpi}</span></div>
          <div className="inspector-row"><span className="label">Max upload size</span><span>{(config.maxUploadBytes / (1024 * 1024)).toFixed(0)} MB</span></div>
          <div className="inspector-row"><span className="label">Forms in catalog</span><span>{config.formCount}</span></div>
          <div className="inspector-row"><span className="label">Classify concurrency</span><span>{config.classifyConcurrency}</span></div>
          <div className="inspector-row"><span className="label">OCR workers</span><span>{config.ocrWorkers}</span></div>
          <div className="inspector-row"><span className="label">Max cost per run</span><span>${config.maxRunCostUsd.toFixed(2)}</span></div>
        </div>
      )}
    </div>
  )
}

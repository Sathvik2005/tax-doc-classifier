export type PageResult = {
  page: number
  pending?: boolean
  skipped: boolean
  reason?: string
  error?: string
  ocr?: boolean
  ocrUncertain?: boolean
  text?: string
  form?: string
  kind?: string
  formConfidence?: number
  kindConfidence?: number
  stepConfidences?: number[]
  gated?: boolean
  calls?: number
  inputTokens?: number
  probabilities?: { form: Record<string, number>; kind: Record<string, number>; sub?: Record<string, number> }
}

export type CriteriaEntry = {
  id: string
  label: string
  title: string
  pageCount: number
  parent?: string
  boxes?: string[]
  notFor?: string[]
}

export type EvalRunSummary = { file: string; corpus: unknown; gate: unknown; summary: unknown }

export type AppConfig = {
  gate: number
  maxUploadBytes: number
  pageImageDpi: number
  model: string
  formCount: number
  classifyConcurrency: number
  ocrWorkers: number
  maxRunCostUsd: number
}

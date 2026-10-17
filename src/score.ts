import type { PageResult } from './classify.js'

export type Scored = { truth: string; result: PageResult; wrong: boolean; strict: boolean }

export function score(truth: string, result: PageResult, gate = 0.95): Scored {
  const wrong = truth !== result.form
  return { truth, result, wrong, strict: wrong || result.formConfidence < gate }
}

export type Summary = {
  pages: number
  wrong: number
  strict: number
  strictRate: number
  calls: number
  inputTokens: number
  estCostUsd: number
}

export function summarize(rows: Scored[], usdPerMillionTokens = 0.042): Summary {
  const pages = rows.length
  const wrong = rows.filter((r) => r.wrong).length
  const strict = rows.filter((r) => r.strict).length
  const calls = rows.reduce((n, r) => n + r.result.calls, 0)
  const inputTokens = rows.reduce((n, r) => n + r.result.inputTokens, 0)
  return { pages, wrong, strict, strictRate: pages ? strict / pages : 0, calls, inputTokens, estCostUsd: (inputTokens * usdPerMillionTokens) / 1e6 }
}

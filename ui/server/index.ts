import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createWorker, type Worker } from 'tesseract.js'
import {
  classifyPage,
  firstListCriteria,
  isBlank,
  isCoverSheet,
  jevBackend,
  linesOf,
  pdfPageCount,
  pdfPageLines,
  type Criteria,
} from '../../src/index.js'

const run = promisify(execFile)
const PORT = Number(process.env.PORT ?? 8787)
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024 // fits a 500-page scanned PDF with headroom
const PAGE_IMAGE_DPI = 180
const GATE = 0.95 // mirrors classifyPage's own default (src/classify.ts) — not independently configurable yet
const MODEL = 'jev-latest' // mirrors jevBackend's default model (src/backend.ts)
const CLASSIFY_CONCURRENCY = Number(process.env.JEV_CONCURRENCY ?? 8) // cap sized to the vendor's rate limit, see docs/JEV-PRODUCTION-SYSTEM-DESIGN.md §2.1
const OCR_WORKER_COUNT = Number(process.env.OCR_WORKERS ?? 4)
const PRICE_PER_1M_TOKENS = 0.042
const MAX_RUN_COST_USD = Number(process.env.JEV_MAX_RUN_COST_USD ?? 5) // hard budget cap, see §2.4
const JOB_TTL_MS = 20 * 60 * 1000

const root = fileURLToPath(new URL('../..', import.meta.url))
const criteriaPath = join(root, 'data', 'criteria.json')
const resultsDir = join(root, 'eval', 'results')
const criteria = JSON.parse(await readFile(criteriaPath, 'utf8')) as Criteria
const firstList = firstListCriteria(criteria)
const backend = jevBackend()

// ---- jobs ---------------------------------------------------------------
// A job is an uploaded PDF kept on disk long enough to stream its classify
// results and serve on-demand page previews, then swept after JOB_TTL_MS of
// inactivity. Pages are rendered once and cached in the job's directory
// instead of being re-rendered (or embedded as base64) per request — that's
// what makes 500-page previews cheap.
type Job = { dir: string; file: string; pageCount: number; timer: ReturnType<typeof setTimeout> }
const jobs = new Map<string, Job>()

function touchJob(id: string): Job | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  clearTimeout(job.timer)
  job.timer = setTimeout(() => {
    jobs.delete(id)
    rm(job.dir, { recursive: true, force: true }).catch(() => {})
  }, JOB_TTL_MS)
  return job
}

// ---- OCR fallback -----------------------------------------------------
// Pages with no embedded text layer (scanned PDFs, "print to PDF" output that
// rasterized the page into images) return nothing from pdftotext. Rather than
// silently reporting those as blank, render the page and OCR it.
// Uses tesseract.js (WASM, bundled) instead of a system `tesseract` binary —
// nothing to install on the host — and a small worker pool so OCR-heavy
// batches don't serialize behind a single worker.
let ocrPoolPromise: Promise<Worker[]> | undefined
function ocrPool(): Promise<Worker[]> {
  if (!ocrPoolPromise) ocrPoolPromise = Promise.all(Array.from({ length: OCR_WORKER_COUNT }, () => createWorker('eng')))
  return ocrPoolPromise
}
let nextOcrWorker = 0

// Pages are identified by an exact `page-<n>-<suffix>.png` match — a naive
// startsWith("page-1") would also match "page-10-10.png", "page-100-...png",
// etc, corrupting previews once pages render concurrently instead of strictly
// in order.
function pagePngRegex(page: number): RegExp {
  return new RegExp(`^page-${page}-\\d+\\.png$`)
}

async function renderPagePng(file: string, page: number, workDir: string): Promise<string | undefined> {
  const re = pagePngRegex(page)
  const cached = (await readdir(workDir)).find((f) => re.test(f))
  if (cached) return join(workDir, cached)
  const prefix = join(workDir, `page-${page}`)
  await run('pdftoppm', ['-png', '-r', String(PAGE_IMAGE_DPI), '-f', String(page), '-l', String(page), file, prefix])
  const png = (await readdir(workDir)).find((f) => re.test(f))
  return png ? join(workDir, png) : undefined
}

// `failed: true` means OCR could not run at all (engine error, bad image) —
// this must never be treated the same as "OCR ran cleanly and found nothing,"
// since the former tells you nothing about whether the page is actually
// blank. Collapsing the two was exactly how a scanned, non-blank page ended
// up auto-gated as "blank, 100% confident."
async function ocrImage(imagePath: string): Promise<{ lines: string[]; failed: boolean }> {
  try {
    const pool = await ocrPool()
    const worker = pool[nextOcrWorker++ % pool.length]
    const { data } = await worker.recognize(imagePath)
    return { lines: linesOf(data.text), failed: false }
  } catch (err) {
    console.warn('OCR failed:', err instanceof Error ? err.message : err)
    return { lines: [], failed: true }
  }
}

// ---- POST /api/classify — accepts the upload, returns a job handle -------
async function handleUpload(req: import('node:http').IncomingMessage): Promise<{ status: number; body: unknown }> {
  const bytes = await readBody(req, MAX_UPLOAD_BYTES)
  if (bytes[0] !== 0x25) throw new Error('uploaded file is not a PDF')

  const dir = await mkdtemp(join(tmpdir(), 'taxdoc-ui-'))
  const file = join(dir, 'upload.pdf')
  await writeFile(file, bytes)

  let pageCount: number
  try {
    pageCount = await pdfPageCount(file)
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`could not read PDF: ${err instanceof Error ? err.message : err}`)
  }

  const jobId = randomUUID()
  jobs.set(jobId, { dir, file, pageCount, timer: setTimeout(() => {}, 0) })
  touchJob(jobId)
  return { status: 200, body: { jobId, pageCount } }
}

async function readBody(req: import('node:http').IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error(`upload exceeds ${limit} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// ---- GET /api/classify/:jobId/stream — NDJSON, one line per page ---------
// A bounded worker pool (the same shared-queue shape as eval/run.ts) pulls
// pages off a queue; results stream out as they land instead of waiting for
// the whole document, and one page failing never aborts the rest of the run.
type StreamResult =
  | { page: number; skipped: true; reason: 'cover_sheet' | 'error'; error?: string }
  | ({ page: number; skipped: false; ocr: boolean; ocrUncertain: boolean; text: string } & Awaited<ReturnType<typeof classifyPage>>)

async function streamJob(job: Job, res: import('node:http').ServerResponse): Promise<void> {
  const queue = Array.from({ length: job.pageCount }, (_, i) => i + 1)
  let costUsd = 0
  let budgetExceeded = false

  async function worker() {
    for (;;) {
      if (budgetExceeded) return
      const page = queue.shift()
      if (page === undefined) return
      let result: StreamResult
      try {
        const imagePath = await renderPagePng(job.file, page, job.dir).catch(() => undefined)
        let lines = await pdfPageLines(job.file, page)
        let ocr = false
        // ocrUncertain: OCR either couldn't be attempted (page failed to
        // render) or threw instead of running cleanly. Either way we have no
        // real signal on whether this page is actually blank — never let
        // Jev's confidence on an empty/garbage state auto-gate it.
        let ocrUncertain = false
        if (isBlank(lines)) {
          if (!imagePath) {
            ocrUncertain = true
          } else {
            const ocrResult = await ocrImage(imagePath)
            if (ocrResult.failed) {
              ocrUncertain = true
            } else if (!isBlank(ocrResult.lines)) {
              lines = ocrResult.lines
              ocr = true
            }
            // else: OCR ran cleanly and found nothing — genuinely blank, not uncertain
          }
        }
        if (isCoverSheet(lines)) {
          result = { page, skipped: true, reason: 'cover_sheet' }
        } else {
          const r = await classifyPage(lines, { backend, criteria, firstList, gate: GATE })
          costUsd += (r.inputTokens * PRICE_PER_1M_TOKENS) / 1e6
          if (costUsd >= MAX_RUN_COST_USD) budgetExceeded = true
          result = { page, skipped: false, ocr, ocrUncertain, text: lines.join('\n'), ...r, gated: ocrUncertain ? false : r.gated }
        }
      } catch (err) {
        result = { page, skipped: true, reason: 'error', error: err instanceof Error ? err.message : String(err) }
      }
      res.write(JSON.stringify(result) + '\n')
    }
  }

  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, job.pageCount) }, worker))
  res.write(JSON.stringify({ done: true, budgetExceeded }) + '\n')
  res.end()
}

// ---- /api/catalog ---------------------------------------------------------
function handleCatalog(): { status: number; body: unknown } {
  return { status: 200, body: { forms: Object.values(criteria) } }
}

// ---- /api/config ------------------------------------------------------
function handleConfig(): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      gate: GATE,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      pageImageDpi: PAGE_IMAGE_DPI,
      model: MODEL,
      formCount: Object.keys(criteria).length,
      classifyConcurrency: CLASSIFY_CONCURRENCY,
      ocrWorkers: OCR_WORKER_COUNT,
      maxRunCostUsd: MAX_RUN_COST_USD,
    },
  }
}

// ---- /api/eval-results ----------------------------------------------------
const EVAL_FILE_RE = /^[\w.-]+\.json$/

async function listEvalResults(): Promise<{ file: string; corpus: unknown; gate: unknown; summary: unknown }[]> {
  let files: string[] = []
  try {
    files = (await readdir(resultsDir)).filter((f) => EVAL_FILE_RE.test(f))
  } catch {
    return []
  }
  files.sort().reverse()
  const out = []
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(join(resultsDir, file), 'utf8')) as Record<string, unknown>
      out.push({ file, corpus: data.corpus, gate: data.gate, summary: data.summary })
    } catch {
      // skip unreadable/malformed result files
    }
  }
  return out
}

async function handleEvalResults(fileParam: string | null): Promise<{ status: number; body: unknown }> {
  if (!fileParam) return { status: 200, body: { results: await listEvalResults() } }
  if (!EVAL_FILE_RE.test(fileParam)) return { status: 400, body: { error: 'invalid file name' } }
  try {
    const data = JSON.parse(await readFile(join(resultsDir, fileParam), 'utf8'))
    return { status: 200, body: data }
  } catch {
    return { status: 404, body: { error: 'not found' } }
  }
}

// ---- router ---------------------------------------------------------------
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  const streamMatch = url.pathname.match(/^\/api\/classify\/([^/]+)\/stream$/)
  if (req.method === 'GET' && streamMatch) {
    const job = touchJob(streamMatch[1])
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'job not found or expired' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    try {
      await streamJob(job, res)
    } catch (err) {
      res.write(JSON.stringify({ done: true, error: err instanceof Error ? err.message : String(err) }) + '\n')
      res.end()
    }
    return
  }

  const previewMatch = url.pathname.match(/^\/api\/classify\/([^/]+)\/preview\/(\d+)$/)
  if (req.method === 'GET' && previewMatch) {
    const job = touchJob(previewMatch[1])
    const page = Number(previewMatch[2])
    if (!job || page < 1 || page > job.pageCount) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    try {
      const imagePath = await renderPagePng(job.file, page, job.dir)
      if (!imagePath) throw new Error('render failed')
      const bytes = await readFile(imagePath)
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=600' })
      res.end(bytes)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
    return
  }

  try {
    let result: { status: number; body: unknown }
    if (req.method === 'POST' && url.pathname === '/api/classify') {
      result = await handleUpload(req)
    } else if (req.method === 'GET' && url.pathname === '/api/catalog') {
      result = handleCatalog()
    } else if (req.method === 'GET' && url.pathname === '/api/config') {
      result = handleConfig()
    } else if (req.method === 'GET' && url.pathname === '/api/eval-results') {
      result = await handleEvalResults(url.searchParams.get('file'))
    } else {
      result = { status: 404, body: { error: 'not found' } }
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }
})

server.listen(PORT, () => console.log(`classify server → http://localhost:${PORT}`))

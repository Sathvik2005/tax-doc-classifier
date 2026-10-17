import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
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
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
const PAGE_IMAGE_DPI = 180
const GATE = 0.95 // mirrors classifyPage's own default (src/classify.ts) — not independently configurable yet
const MODEL = 'jev-latest' // mirrors jevBackend's default model (src/backend.ts)

const root = fileURLToPath(new URL('../..', import.meta.url))
const criteriaPath = join(root, 'data', 'criteria.json')
const resultsDir = join(root, 'eval', 'results')
const criteria = JSON.parse(await readFile(criteriaPath, 'utf8')) as Criteria
const firstList = firstListCriteria(criteria)
const backend = jevBackend()

// ---- OCR fallback -----------------------------------------------------
// Pages with no embedded text layer (scanned PDFs, "print to PDF" output that
// rasterized the page into images) return nothing from pdftotext. Rather than
// silently reporting those as blank, render the page and OCR it.
let ocrAvailable: boolean | undefined
async function tesseractAvailable(): Promise<boolean> {
  if (ocrAvailable === undefined) {
    ocrAvailable = await run('tesseract', ['--version'])
      .then(() => true)
      .catch(() => false)
    if (!ocrAvailable) console.warn('tesseract not found on PATH — pages with no text layer will stay "blank"')
  }
  return ocrAvailable
}

async function renderPagePng(file: string, page: number, workDir: string): Promise<string | undefined> {
  const prefix = join(workDir, `page-${page}`)
  await run('pdftoppm', ['-png', '-r', String(PAGE_IMAGE_DPI), '-f', String(page), '-l', String(page), file, prefix])
  const png = (await readdir(workDir)).find((f) => f.startsWith(`page-${page}`) && f.endsWith('.png'))
  return png ? join(workDir, png) : undefined
}

async function ocrImage(imagePath: string): Promise<string[]> {
  if (!(await tesseractAvailable())) return []
  const { stdout } = await run('tesseract', [imagePath, 'stdout'])
  return linesOf(stdout)
}

async function toDataUrl(imagePath: string | undefined): Promise<string | undefined> {
  if (!imagePath) return undefined
  const bytes = await readFile(imagePath)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

// ---- /api/classify ------------------------------------------------------
type ApiPageResult =
  | { page: number; skipped: true; reason: 'cover_sheet'; preview?: string }
  | ({ page: number; skipped: false; ocr: boolean; text: string; preview?: string } & Awaited<ReturnType<typeof classifyPage>>)

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

async function handleClassify(req: import('node:http').IncomingMessage): Promise<{ status: number; body: unknown }> {
  let dir: string | undefined
  try {
    const bytes = await readBody(req, MAX_UPLOAD_BYTES)
    if (bytes[0] !== 0x25) throw new Error('uploaded file is not a PDF')

    dir = await mkdtemp(join(tmpdir(), 'taxdoc-ui-'))
    const file = join(dir, 'upload.pdf')
    await writeFile(file, bytes)

    const pageCount = await pdfPageCount(file)
    const results: ApiPageResult[] = []
    for (let page = 1; page <= pageCount; page++) {
      const imagePath = await renderPagePng(file, page, dir).catch(() => undefined)
      const preview = await toDataUrl(imagePath)

      let lines = await pdfPageLines(file, page)
      let ocr = false
      if (isBlank(lines) && imagePath) {
        const ocrLines = await ocrImage(imagePath)
        if (!isBlank(ocrLines)) {
          lines = ocrLines
          ocr = true
        }
      }
      if (isCoverSheet(lines)) {
        results.push({ page, skipped: true, reason: 'cover_sheet', preview })
        continue
      }
      const result = await classifyPage(lines, { backend, criteria, firstList, gate: GATE })
      results.push({ page, skipped: false, ocr, text: lines.join('\n'), preview, ...result })
    }

    return { status: 200, body: { pageCount, results } }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
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
  try {
    let result: { status: number; body: unknown }
    if (req.method === 'POST' && url.pathname === '/api/classify') {
      result = await handleClassify(req)
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

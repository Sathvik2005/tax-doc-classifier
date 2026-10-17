import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyPage,
  firstListCriteria,
  isCoverSheet,
  jevBackend,
  pdfPageCount,
  pdfPageLines,
  type Criteria,
} from '../../src/index.js'

const PORT = Number(process.env.PORT ?? 8787)
const MAX_BYTES = 32 * 1024 * 1024

const criteriaPath = fileURLToPath(new URL('../../data/criteria.json', import.meta.url))
const criteria = JSON.parse(await readFile(criteriaPath, 'utf8')) as Criteria
const firstList = firstListCriteria(criteria)
const backend = jevBackend()

type ApiPageResult =
  | { page: number; skipped: true; reason: 'cover_sheet' }
  | ({ page: number; skipped: false } & Awaited<ReturnType<typeof classifyPage>>)

async function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BYTES) throw new Error(`upload exceeds ${MAX_BYTES} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method !== 'POST' || req.url !== '/api/classify') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  let dir: string | undefined
  try {
    const bytes = await readBody(req)
    if (bytes[0] !== 0x25) throw new Error('uploaded file is not a PDF')

    dir = await mkdtemp(join(tmpdir(), 'taxdoc-ui-'))
    const file = join(dir, 'upload.pdf')
    await writeFile(file, bytes)

    const pageCount = await pdfPageCount(file)
    const results: ApiPageResult[] = []
    for (let page = 1; page <= pageCount; page++) {
      const lines = await pdfPageLines(file, page)
      if (isCoverSheet(lines)) {
        results.push({ page, skipped: true, reason: 'cover_sheet' })
        continue
      }
      const result = await classifyPage(lines, { backend, criteria, firstList })
      results.push({ page, skipped: false, ...result })
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ pageCount, results }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

server.listen(PORT, () => console.log(`classify server → http://localhost:${PORT}`))

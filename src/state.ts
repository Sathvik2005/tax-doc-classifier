import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type PageState = { header: string; body: string; footer: string }

export function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0)
}

export function buildState(lines: string[], bodyChars = 2500): PageState {
  const long = lines.length > 18
  const header = lines.slice(0, 12)
  const footer = long ? lines.slice(-6) : []
  const body = long ? lines.slice(12, -6) : lines.slice(12)
  return { header: header.join('\n'), body: body.join('\n').slice(0, bodyChars), footer: footer.join('\n') }
}

export function isBlank(lines: string[]): boolean {
  const t = lines.join(' ').trim()
  return t.length < 60 || /intentionally left blank|left blank intentionally/i.test(t)
}

export function isCoverSheet(lines: string[]): boolean {
  return lines.length > 0 && lines[0].trim().startsWith('Attention')
}

export async function pdfPageCount(file: string): Promise<number> {
  const { stdout } = await run('pdfinfo', [file])
  const m = stdout.match(/^Pages:\s+(\d+)/m)
  if (!m) throw new Error(`pdfinfo gave no page count for ${file}`)
  return Number(m[1])
}

export async function pdfPageLines(file: string, page: number): Promise<string[]> {
  const { stdout } = await run('pdftotext', ['-layout', '-f', String(page), '-l', String(page), file, '-'], {
    maxBuffer: 16 * 1024 * 1024,
  })
  return linesOf(stdout)
}

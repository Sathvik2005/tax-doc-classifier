export const ID_GRAMMAR =
  /^form-(\d+(-[a-z]{1,4})?|w-2[a-z]{0,2}|t|rrb-1042-s|ssa-1042-s|499-w-2-pr)(-schedule-(\d+(-[a-z])?|[a-z]{1,3}(-\d)?))?(\/p\d+)?$|^blank$/

export function isFormId(id: string): boolean {
  return ID_GRAMMAR.test(id)
}

export function formOf(id: string): string {
  return id.split('/')[0]
}

export function pageOf(id: string): number | undefined {
  const m = id.match(/\/p(\d+)$/)
  return m ? Number(m[1]) : undefined
}

export function parentOf(id: string): string | undefined {
  const m = formOf(id).match(/^(form-.+?)-schedule-/)
  return m ? m[1] : undefined
}

export function mefNameToId(name: string): string {
  const m = name.trim().match(/^Form (\S+)(?: Schedule (\S+))?$/)
  if (!m) throw new Error(`not a MeF form name: ${name}`)
  let f = m[1].toUpperCase()
  f = f.replace(/^W2/, 'W-2')
  f = f.replace(/^(RRB|SSA)1042S$/, '$1-1042-S')
  f = f.replace(/^499W2PR$/, '499-W-2-PR')
  f = f.replace(/^(\d+)([A-Z]+)$/, '$1-$2')
  let id = `form-${f.toLowerCase()}`
  if (m[2]) {
    let s = m[2].toUpperCase()
    s = s.replace(/^([A-Z])(\d)$/, '$1-$2').replace(/^(\d)([A-Z])$/, '$1-$2')
    id += `-schedule-${s.toLowerCase()}`
  }
  return id
}

export function labelOf(id: string): string {
  const m = formOf(id).match(/^form-(.+?)(?:-schedule-(.+))?$/)
  if (!m) return id
  const base = m[1].toUpperCase()
  return m[2] ? `Schedule ${m[2].toUpperCase()} (Form ${base})` : `Form ${base}`
}

export function irsPdfName(id: string): string {
  const m = formOf(id).match(/^form-(.+?)(?:-schedule-(.+))?$/)
  if (!m) throw new Error(`no IRS file for ${id}`)
  const base = m[1].replace(/-/g, '')
  if (!m[2]) return `f${base}.pdf`
  const s = m[2].replace(/-/g, '')
  if (base === '1040' && s === '8812') return 'f1040s8.pdf'
  if (base === '1040' && s === 'eic') return 'f1040sei.pdf'
  if (base === '1040nr') return `f1040nr${s[0]}.pdf`
  if (base === '1118' && s === 'i') return 'f1118s1.pdf'
  if (base === '8995a') return `f8995a${s}.pdf`
  return `f${base}s${s}.pdf`
}

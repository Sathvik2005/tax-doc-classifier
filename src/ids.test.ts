import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isFormId, mefNameToId, labelOf, parentOf, formOf, pageOf } from './ids.js'

describe('form id grammar', () => {
  it('every id in criteria.json matches the grammar', () => {
    const criteria = JSON.parse(readFileSync(new URL('../data/criteria.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const bad = Object.keys(criteria).filter((id) => !isFormId(id))
    expect(bad).toEqual([])
  })

  it('maps MeF names mechanically', () => {
    expect(mefNameToId('Form 1040 Schedule A')).toBe('form-1040-schedule-a')
    expect(mefNameToId('Form 1040NR Schedule NEC')).toBe('form-1040-nr-schedule-nec')
    expect(mefNameToId('Form 8995A Schedule A')).toBe('form-8995-a-schedule-a')
    expect(mefNameToId('Form 1065 Schedule K1')).toBe('form-1065-schedule-k-1')
    expect(mefNameToId('Form 1040 Schedule 1A')).toBe('form-1040-schedule-1-a')
    expect(mefNameToId('Form W2G')).toBe('form-w-2g')
    expect(mefNameToId('Form 1099R')).toBe('form-1099-r')
  })

  it('pages are a suffix and every prefix is a form id', () => {
    expect(isFormId('form-1040/p2')).toBe(true)
    expect(formOf('form-1040/p2')).toBe('form-1040')
    expect(pageOf('form-1040/p2')).toBe(2)
    expect(pageOf('form-1040')).toBeUndefined()
    expect(parentOf('form-5471-schedule-j')).toBe('form-5471')
    expect(labelOf('form-5471-schedule-j')).toBe('Schedule J (Form 5471)')
    expect(isFormId('schedule-a')).toBe(false)
    expect(isFormId('form-5471/sch-j')).toBe(false)
  })
})

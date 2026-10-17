import type { Backend, ChoiceAnswer, ChoiceQuestion, Criterion } from './backend.js'
import { buildState, isBlank } from './state.js'

export type CriteriaEntry = {
  id: string
  label: string
  title: string
  pageCount: number
  parent?: string
  boxes?: string[]
  notFor?: string[]
}
export type Criteria = Record<string, CriteriaEntry>

export const KINDS = [
  'form_page',
  'instructions',
  'blank',
  'cover_sheet',
  'state_tax_form',
  'broker_or_bank_statement',
  'letter_or_other',
] as const
export type Kind = (typeof KINDS)[number]

export const KIND_CRITERIA: Record<Kind, Criterion> = {
  form_page: {
    what: 'A page with at least one fillable entry (numbered lines, boxes, name/TIN fields), even if it also carries instruction text',
    examples: ['1 Wages, tips, other compensation $', 'Name(s) shown on return  Your social security number', 'Line 7 Subtract line 6 from line 5'],
  },
  instructions: {
    what: 'Only instruction prose — who must file, definitions, box explanations — with no fillable entry anywhere on the page',
    examples: ['Instructions for Recipient', 'General Instructions', 'Purpose of Form', 'Future Developments'],
  },
  blank: { what: 'A blank page or one that says it is intentionally left blank; little or no text' },
  cover_sheet: { what: 'A cover or notice page (Attention notices, filing warnings, transmittal sheets)' },
  state_tax_form: {
    what: 'A STATE or local income tax form or schedule (e.g. California 540, New York IT-201, New Jersey NJ-1040), issued by a state agency, not the IRS',
  },
  broker_or_bank_statement: {
    what: 'A brokerage, bank, payroll or custodian statement: consolidated 1099 summary pages, account summaries, transaction detail, realized gain/loss reports',
  },
  letter_or_other: {
    what: 'Any other page: a cover letter, engagement letter, invoice, filing instructions, e-file authorization, preparer worksheet, or notice',
  },
}

export const RARE_PARENTS = ['form-5471', 'form-8865', 'form-8933', 'form-1118', 'form-5713'] as const

const FAMILY_WHAT: Record<string, string> = {
  'form-5471': 'Form 5471 (Information Return of U.S. Persons With Respect to Certain Foreign Corporations) or any of its Schedules E, G-1, H, I-1, J, M, O, P, Q, R',
  'form-8865': 'Form 8865 (Return of U.S. Persons With Respect to Certain Foreign Partnerships) or its Schedules G, H, K-1, K-2, K-3, O, P',
  'form-8933': 'Form 8933 (Carbon Oxide Sequestration Credit) or its Schedules A-F',
  'form-1118': 'Form 1118 (Foreign Tax Credit — Corporations) or its Schedules I, J, K, L',
  'form-5713': 'Form 5713 (International Boycott Report) or its Schedules A, B, C',
}

const NOT_IN_LIST = 'not_in_this_list'

const FORM_INSTRUCTIONS =
  'Which IRS form (or form family) is this page from? Read the form number and title in the header and the footer line (e.g. "Form 8880 (2025)", "Schedule A (Form 1040)"). An instructions page belongs to the form it instructs. If the form is not among the options, choose not_in_this_list.'

export function criterionFor(e: CriteriaEntry): Criterion {
  const c: Criterion = { what: e.title ? `${e.label} — ${e.title}` : e.label }
  if (e.boxes?.length) c.examples = e.boxes
  if (e.notFor?.length) c.not_for = `Not ${e.notFor.join(', ')}`
  return c
}

export function familyOf(id: string, criteria: Criteria): string {
  const parent = criteria[id]?.parent
  if (parent && (RARE_PARENTS as readonly string[]).includes(parent)) return parent
  return id
}

export function firstListCriteria(criteria: Criteria): Record<string, Criterion> {
  const out: Record<string, Criterion> = {}
  for (const id of Object.keys(criteria).sort()) {
    const fam = familyOf(id, criteria)
    if (fam !== id) continue
    out[id] = (RARE_PARENTS as readonly string[]).includes(id) ? { what: FAMILY_WHAT[id] } : criterionFor(criteria[id])
  }
  out[NOT_IN_LIST] = { what: 'The page belongs to a form or schedule that is NOT one of the options above' }
  return out
}

export function membersOf(parent: string, criteria: Criteria): string[] {
  return Object.keys(criteria)
    .filter((id) => id === parent || criteria[id].parent === parent)
    .sort()
}

export type ClassifyOptions = {
  backend: Backend
  criteria: Criteria
  gate?: number
  firstList?: Record<string, Criterion>
}

export type PageResult = {
  form: string
  kind: Kind
  formConfidence: number
  kindConfidence: number
  stepConfidences: number[]
  gated: boolean
  calls: number
  inputTokens: number
  probabilities: { form: Record<string, number>; kind: Record<string, number>; sub?: Record<string, number> }
}

function best(a: ChoiceAnswer, exclude: string): [string, number] {
  let top: [string, number] = ['', -1]
  for (const [k, v] of Object.entries(a.probabilities)) if (k !== exclude && v > top[1]) top = [k, v]
  return top
}

export async function classifyPage(lines: string[], opts: ClassifyOptions): Promise<PageResult> {
  const gate = opts.gate ?? 0.95
  if (isBlank(lines)) {
    return {
      form: 'blank',
      kind: 'blank',
      formConfidence: 1,
      kindConfidence: 1,
      stepConfidences: [1],
      gated: true,
      calls: 0,
      inputTokens: 0,
      probabilities: { form: { blank: 1 }, kind: { blank: 1 } },
    }
  }
  const state = buildState(lines)
  const firstList = opts.firstList ?? firstListCriteria(opts.criteria)
  const q1: Record<string, ChoiceQuestion> = {
    kind: { type: 'choice', instructions: 'What kind of page is this?', criteria: KIND_CRITERIA },
    form: { type: 'choice', instructions: FORM_INSTRUCTIONS, criteria: firstList },
  }
  const r1 = await opts.backend.ask(state, q1)
  const kindA = r1.answers.kind
  const formA = r1.answers.form
  let [form, formP] = best(formA, NOT_IN_LIST)
  const steps = [formP]
  let calls = 1
  let inputTokens = r1.inputTokens
  let sub: Record<string, number> | undefined
  if ((RARE_PARENTS as readonly string[]).includes(form)) {
    const members = membersOf(form, opts.criteria)
    const crit: Record<string, Criterion> = {}
    for (const id of members) crit[id] = criterionFor(opts.criteria[id])
    crit[NOT_IN_LIST] = { what: 'The page belongs to a form that is NOT one of the options above' }
    const r2 = await opts.backend.ask(state, {
      sub: {
        type: 'choice',
        instructions: `Which specific form or schedule is this page from? All options belong to: ${FAMILY_WHAT[form]}. Read the form number in the header and footer; an instructions page belongs to the form it instructs.`,
        criteria: crit,
      },
    })
    calls++
    inputTokens += r2.inputTokens
    sub = r2.answers.sub.probabilities
    const [leaf, leafP] = best(r2.answers.sub, NOT_IN_LIST)
    form = leaf
    steps.push(leafP)
  }
  const kind = kindA.choice as Kind
  const formConfidence = Math.min(...steps)
  return {
    form,
    kind,
    formConfidence,
    kindConfidence: kindA.confidence,
    stepConfidences: steps,
    gated: formConfidence >= gate,
    calls,
    inputTokens,
    probabilities: { form: formA.probabilities, kind: kindA.probabilities, ...(sub ? { sub } : {}) },
  }
}

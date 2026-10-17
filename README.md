# tax-doc-classifier

A tax document classifier built with Jev.

We ingest thousands of tax documents using an LLM pipeline built last tax season. Jev classifies 100% of our tax document corpus at $0.001 per page — 34× cheaper and 6× faster than that LLM setup. This is the classifier, open sourced.

One request per page. The page's text goes to [Jev](https://docs.typesafe.ai), TypeSafe's decision model, which returns a probability over 261 IRS forms and 7 page kinds instead of text. No model is trained and nothing is hosted: the classifier is a JSON file describing each form, generated from the IRS's own PDFs.

```ts
import { classifyPage, jevBackend, pdfPageLines } from 'tax-doc-classifier'
import criteria from 'tax-doc-classifier/data/criteria.json' with { type: 'json' }

const lines = await pdfPageLines('return.pdf', 3)
const r = await classifyPage(lines, { backend: jevBackend(), criteria })
// r.form            'form-1040-schedule-a'
// r.kind            'form_page'
// r.formConfidence  0.99
// r.gated           true   (formConfidence >= 0.95)
```

No model is trained and nothing is hosted. The classifier is a JSON file of form descriptions (`data/criteria.json`) and a decision model that reads a page and picks from them. The decision model is [TypeSafe Jev](https://docs.typesafe.ai), a System One model that returns a probability over options instead of text.

## Setup

1. **Node 20+ and pnpm.**
2. **poppler** — provides `pdftotext` and `pdfinfo`, used to read PDF pages. Only `classifyPage` on lines of text works without it.
   - macOS: `brew install poppler`
   - Debian/Ubuntu: `apt install poppler-utils`
3. **A TypeSafe API key.** Get one at [typesafe.ai](https://typesafe.ai), then:
   ```
   export TYPESAFE_API_KEY=…
   ```
   or put it in a `.env` file (git-ignored) and load it with your usual tooling. The key is read from the environment by `jevBackend()`; it is never written to disk or logged.
4. **Install and check:**
   ```
   pnpm install
   pnpm typecheck
   pnpm test
   ```

To use it as a dependency in another project:

```
pnpm add github:<org>/tax-doc-classifier
```

The published package ships `dist/` and `data/criteria.json`; `pdftotext` is still required on the host for the PDF helpers.

## Results

The score is **strict**: a page counts as an error if the answer is wrong *or* its confidence is below 0.95. Every number below is reproducible with `pnpm eval`.

| Corpus | Pages | Forms | Wrong | Strict errors | Cost |
|---|---|---|---|---|---|
| TaxCalcBench filled forms (W-2, 1040, 1099-x, 1098-x) | 314 | 15 | 0 | **0 (0.00%)** | $0.36 |
| Blank IRS forms (every TY2025 MeF 1040-series form + 40 information returns) | 753 | 261 | 0 | 38 (5.05%) | $0.86 |

The 38 low-confidence pages on the blank corpus are instruction pages that name no form, deep pages of corporate forms (5471, 8865, 1118), and single-schedule forms hedging against their parent. None is wrong.

### Against the LLM setup it replaces

Measured on the same bench pages, same machine, same hour. The previous classifier sends each page as a PDF to Claude Sonnet with the form registry in the prompt; different pages never share the prompt cache, so every page pays the full prompt.

| Per page | Sonnet classifier | Jev classifier | |
|---|---|---|---|
| Cost | $0.039 | $0.00115 | **34× cheaper** |
| Latency, warm | ~3.3 s | ~0.5 s | **6× faster** |
| Forms it can name | 30 (phrase table) | 261 | |

## How it works

```
PDF page ──pdftotext──▶ { header, body, footer }
                              │
                              ▼  one request
                     kind  : 7 options
                     form  : 230 options + not_in_this_list
                              │
                              ▼  second request only if form ∈ {5471, 8865, 8933, 1118, 5713}
                     sub   : that form and its schedules
                              │
                              ▼
        { form, kind, formConfidence, gated, probabilities }
```

- A blank page is answered without a call.
- The 230 first-list options are every form as the page prints it. Five corporate/foreign forms absorb their 35 schedules and get a second, small question; the hierarchy exists only where the page announces the parent more clearly than the schedule.
- `formConfidence` is the minimum over steps. Gate on it: above the gate, act; below, fall back to whatever you use today.

### Page kinds

`form_page` · `instructions` · `blank` · `cover_sheet` · `state_tax_form` · `broker_or_bank_statement` · `letter_or_other`

The last three route a page away from the federal form list; they are defined but not yet evaluated.

## Form ids

Ids follow the IRS MeF naming, kebab-cased, parent first:

```
form-1040                 form-1040-schedule-a        form-1040-nr-schedule-nec
form-1099-int             form-w-2g                   form-5471-schedule-j
form-1065-schedule-k-1    form-8995-a-schedule-a
```

`Form 1040 Schedule A` in the IRS accepted-forms list becomes `form-1040-schedule-a`, mechanically and in both directions (`mefNameToId`). Every id matches `ID_GRAMMAR`, and the test suite refuses a `criteria.json` that contains one that does not.

A page number, when a caller asks for it, is a suffix: `form-1040/p2`. Every prefix of an id is a valid, less specific id. No suffix means the page was not asked, never "page 1".

## The data file

`data/criteria.json` is generated — never edited by hand:

```
pnpm build-criteria
```

reads the IRS [accepted forms and schedules](https://www.irs.gov/tax-professionals/tax-year-2025-modernized-e-file-schema-and-business-rules-for-individual-tax-returns-and-extensions) XLSX, downloads each form's PDF from irs.gov, and extracts per form: the printed label, the title, the page count, the parent (for schedules), up to 8 box labels (information returns only), and the sibling forms it must not be confused with. Re-run it when the IRS publishes new revisions.

## Evaluation

```
pnpm eval:download                                 # IRS PDFs → eval/corpus/blank
TYPESAFE_API_KEY=… pnpm eval --corpus=blank
TYPESAFE_API_KEY=… pnpm eval --corpus=bench --dir=/path/to/tax_calc_bench/ty25/test_data
```

Each run prints the strict score, lists every strict error with its confidence and runner-up, and writes the full per-page results to `eval/results/`.

The bench corpus is [TaxCalcBench](https://github.com/column-tax/tax-calc-bench) and is not redistributed here.

## Web UI

`ui/` is a small React + Vite frontend with a Node backend that wraps `classifyPage`
and `jevBackend` — upload a tax PDF, get every page classified with its form, kind,
confidence bar, and a gated/needs-review badge.

Requires the same setup as above (Node 20+, poppler's `pdftotext` **and** `pdfinfo`
on PATH, `TYPESAFE_API_KEY`), plus:

```
cd ui
pnpm install
set -a && source ../.env && set +a   # load TYPESAFE_API_KEY (or export it yourself)
pnpm dev                             # runs the Vite dev server + classify API together
```

Open **http://localhost:5173**, upload a PDF, click Classify. The frontend (`:5173`)
proxies `/api/classify` to the backend (`:8787`), which writes the upload to a temp
file, runs it page-by-page through the same pipeline `eval/run.ts` uses, and returns
per-page results — nothing is persisted after the request completes.

See `docs/` for the design docs behind this project: the Jev API contract
(`JEV-CONTEXT.md`), the spec-driven build methodology (`REBUILD-METHODOLOGY.md`), and
production/system-design guidance for running this at scale
(`JEV-PRODUCTION-SYSTEM-DESIGN.md`).

## Plugging in another model

`Backend` is one method: `ask(state, questions) → { answers, inputTokens }` where each answer is a probability distribution over the question's options. `jevBackend` is the only implementation shipped. Anything that can return calibrated probabilities over a labelled option set can implement it.

## Limits

- Text only. Scanned pages need OCR first; a page with no text layer is reported as `blank`.
- Federal forms only. State forms are detected by `kind` but not identified.
- English only.
- Requires `pdftotext` and `pdfinfo` (poppler) on the path for the PDF helpers; `classifyPage` itself takes lines of text and needs neither.
- The confidence is calibrated on the corpora above. Calibrate on your own pages before choosing a gate.

## Requirements

Node 20+, poppler, a TypeSafe API key in `TYPESAFE_API_KEY`.

## Licence

Apache-2.0. See `DATA-LICENSE.md` for the IRS-derived data.

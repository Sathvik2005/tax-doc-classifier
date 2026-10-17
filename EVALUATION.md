# Evaluation

Test strategy, scoring methodology, and how to run and interpret a regression
check against this project's eval corpora.

## Strategy

This project evaluates accuracy with a real scoring harness against real IRS
forms, not spot checks. There is no held-out "test set" in the ML sense —
`data/criteria.json` (the thing being evaluated) and the eval corpora are both
derived from the same IRS source, so a change to one should be checked against
the other (see `docs/JEV-PRODUCTION-SYSTEM-DESIGN.md` §3.4/§3.5 for why these
should be versioned and regenerated together).

Two corpora, run with `pnpm eval`:

| Corpus | What it is | Source |
|---|---|---|
| `blank` | Every TY2025 MeF 1040-series form + 40 information returns, blank | `eval:download` → `eval/corpus/blank`, scored against `eval/manifest.json` |
| `bench` | Filled-in forms (W-2, 1040, 1099-x, 1098-x) | [TaxCalcBench](https://github.com/column-tax/tax-calc-bench) — not redistributed here, pass `--dir=` |

## Scoring methodology (`src/score.ts`)

A page is scored **strict**: it counts as a failure if the answer is **wrong**
*or* its confidence is **below the gate** (default 0.95) — being confidently
wrong and being correctly unconfident both count against the score, because
both represent a page that should not have been auto-accepted as-is.

```ts
wrong  = truth !== result.form
strict = wrong || result.formConfidence < gate
```

`summarize()` aggregates `strictRate` (strict failures / pages), total Jev
calls, input tokens, and estimated cost (`inputTokens × $0.042 / 1e6`).

## Acceptance criteria

These are the numbers currently reproducible with `pnpm eval` and are the bar
any change to `src/classify.ts`, `src/backend.ts`, or `data/criteria.json`
should be checked against:

| Corpus | Pages | Forms | Wrong | Strict errors | Cost |
|---|---|---|---|---|---|
| TaxCalcBench filled forms | 314 | 15 | 0 | 0 (0.00%) | $0.36 |
| Blank IRS forms | 753 | 261 | 0 | 38 (5.05%) | $0.86 |

The 38 low-confidence pages on the blank corpus are instruction pages that name
no form, deep pages of corporate forms (5471, 8865, 1118), and single-schedule
forms hedging against their parent — none is **wrong**, all are correctly
routed to review by the gate.

A regression is: any new `wrong` answer (always a release blocker), or a
material rise in `strictRate` on either corpus without an explanation that
matches one of the known edge cases above.

## Running an eval

```
pnpm eval:download                                 # IRS PDFs → eval/corpus/blank
TYPESAFE_API_KEY=… pnpm eval --corpus=blank
TYPESAFE_API_KEY=… pnpm eval --corpus=bench --dir=/path/to/tax_calc_bench/ty25/test_data
```

Optional flags: `--gate=0.95` (confidence threshold), `--concurrency=12`
(worker-pool size against the Jev API).

Each run prints the strict score, lists every strict-error page (sorted by
confidence, with its predicted form and kind) to the console, and writes the
full per-page results as JSON to `eval/results/<corpus>-<timestamp>.json`. The
web UI's Evaluation page reads these same files via `/api/eval-results`.

## Benchmark procedure (for a classifier/pipeline change)

1. Run `pnpm eval --corpus=blank` and, if you have the bench corpus locally,
   `pnpm eval --corpus=bench --dir=...` **before** your change, and note the
   strict rate and cost.
2. Make the change.
3. Re-run both and diff: any new `wrong` row is a blocker; read every new
   strict row's runner-up confidence to judge whether it's a real regression
   or a borderline case shifting slightly.
4. Record both numbers (before/after) in the PR description — this project's
   convention is to treat the strict-rate diff as the actual code review for
   anything touching the classification logic (`docs/REBUILD-METHODOLOGY.md`
   §5.4).

## Known limitations surfaced by evaluation

- **Text-only input.** The eval corpora are either text-native PDFs or clean
  scans with a usable text layer; it does not exercise OCR quality, since
  `classifyPage` itself takes text and never runs OCR (see `ARCHITECTURE.md`).
  The web UI's OCR fallback (`tesseract.js`) is not covered by `pnpm eval` —
  there is currently no automated regression check for OCR accuracy or for the
  `ocrUncertain` forced-review path; both are presently only exercised manually.
- **Federal forms only.** State forms are detected by `kind` but have no
  dedicated accuracy measurement.
- **English only**, calibrated on English-language IRS forms.
- **Confidence is calibrated on these two corpora specifically.** Re-run
  `pnpm eval` against your own representative pages before trusting the
  default 0.95 gate on a different document population.

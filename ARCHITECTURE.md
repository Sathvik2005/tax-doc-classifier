# Architecture

System design and component responsibilities for `tax-doc-classifier`. For the
Jev/TypeSafe API contract in detail, see `docs/JEV-CONTEXT.md`; for how this was
built as a repeatable method, see `docs/REBUILD-METHODOLOGY.md`; for what it takes
to run this for real, see `docs/JEV-PRODUCTION-SYSTEM-DESIGN.md`.

## Overview

No model is trained and nothing is hosted. The classifier is a generated JSON file
describing 261 IRS forms (`data/criteria.json`) and a pipeline that turns one page
of PDF text into a probability distribution over those forms, by asking
[Jev](https://docs.typesafe.ai) — TypeSafe's "System One" decision model — a
multiple-choice question and reading back a calibrated confidence.

```
PDF page ──pdftotext──▶ { header, body, footer }  (src/state.ts)
                              │
                              ▼  one request               (src/classify.ts, src/backend.ts)
                     kind  : 7 options
                     form  : 230 options + not_in_this_list
                              │
                              ▼  second request only if form ∈ RARE_PARENTS
                     sub   : that form and its schedules
                              │
                              ▼
        { form, kind, formConfidence, gated, probabilities }   (PageResult)
```

## Component responsibilities

| Module | Responsibility |
|---|---|
| `src/ids.ts` | The IRS MeF form-id grammar (`ID_GRAMMAR`), kebab-case naming, and mechanical conversion between IRS form names and ids (`mefNameToId`). Enforced by `src/ids.test.ts` — every id in `criteria.json` must match the grammar. |
| `src/state.ts` | Turns raw text lines into a `PageState` (`{header, body, footer}`), plus the `blank`/`cover_sheet` heuristics and the poppler-backed PDF helpers (`pdfPageCount`, `pdfPageLines` — shell out to `pdfinfo`/`pdftotext`). |
| `src/backend.ts` | The `Backend` interface (`ask(state, questions) → {answers, inputTokens}`) and `jevBackend()`, its only implementation — calls TypeSafe's Jev API with a timeout, linear backoff retry (4 attempts), and a no-retry fast-fail on `402 Payment Required`. |
| `src/classify.ts` | The pipeline itself: builds the `kind`/`form` questions from `criteria.json`, runs the two-step disambiguation for five rare-parent families (`RARE_PARENTS`), and computes the confidence gate. |
| `src/score.ts` | Eval scoring: `wrong` (answer ≠ truth) and `strict` (`wrong` OR confidence below gate), plus `summarize()` for aggregate stats (strict rate, calls, cost). |
| `src/index.ts` | The public package surface — re-exports from the modules above. |
| `data/criteria.json` | Generated, never hand-edited. Built by `scripts/build-criteria.ts` from the IRS's MeF accepted-forms XLSX (unzipped with `fflate`) plus each form's own PDF. |
| `eval/` | The harness: `download.ts` fetches IRS PDFs into `eval/corpus/blank`; `run.ts` scores a corpus with a bounded worker-pool (`concurrency`, default 12) pulling off a shared job queue, and writes results to `eval/results/`. |
| `ui/` | The web app — see below. |

## The web UI's architecture

`ui/src` is a React + Vite frontend; `ui/server/index.ts` is a small Node `http`
server wrapping `classifyPage`/`jevBackend`. It was rebuilt around a job-based,
streaming design specifically so a 500+ page document is tractable (see
"Why job-based streaming" below).

```
POST /api/classify  ──▶  upload saved to a temp job dir, pageCount computed
                          returns { jobId, pageCount } immediately
                              │
GET /api/classify/:jobId/stream  ──▶  bounded worker pool (CLASSIFY_CONCURRENCY)
                          pulls pages off a queue, classifies each one,
                          writes one NDJSON line per page as it completes
                              │
                          per page: render PNG (poppler pdftoppm, cached in the
                          job dir) → pdftotext → if blank, OCR fallback
                          (pooled tesseract.js workers) → classifyPage
                              │
GET /api/classify/:jobId/preview/:page  ──▶  serves the cached PNG on demand
                          (not embedded in the stream — see below)
```

Jobs are swept from disk after `JOB_TTL_MS` (20 minutes) of inactivity.

### Why job-based streaming

The original implementation ran all pages serially inside a single blocking
request and embedded every page's preview image as base64 in the JSON response.
That doesn't survive contact with a 500-page document:

- **One blocking response** means the client sees nothing until the entire
  document finishes — for 500 pages at even a couple of seconds each, that's
  several minutes of a spinner with no progress signal.
- **Embedding every preview upfront** means the response payload scales with
  page count × image size regardless of whether the user ever looks at most of
  those pages — for 500 pages this can run into the hundreds of megabytes.
- **Serial processing** doesn't use the concurrency headroom Jev's API actually
  allows (see `docs/JEV-PRODUCTION-SYSTEM-DESIGN.md` §2.1), so it's slower than
  it needs to be even ignoring OCR.

The fix mirrors the same bounded worker-pool shape `eval/run.ts` already uses
(a shared queue, N workers pulling off it via `Promise.all`), streamed as NDJSON
so the UI gets live per-page results, with previews moved to a separate
on-demand endpoint.

### OCR and the limits of a text-only classifier

`classifyPage` only ever sees text — it has no way to read a scanned page
directly. The UI server's answer to that is an OCR fallback: when `pdftotext`
returns no text for a page, the page is rendered to PNG (poppler `pdftoppm`) and
run through a pooled `tesseract.js` worker (bundled WASM OCR — no system binary
required).

This introduces a specific failure mode worth being explicit about: **Jev cannot
tell the difference between "this page is genuinely blank" and "OCR failed to
extract anything from a non-blank page."** Both look identical to it — an empty
`state` — and it will confidently answer `blank, 100%` either way, because it has
no signal that anything upstream went wrong.

The server handles this by tracking *why* a page ended up with no text, not just
*that* it did:

- OCR ran and found nothing → treated as genuinely blank.
- OCR couldn't run at all (page failed to render) or threw an error →
  `ocrUncertain: true`, and the page's `gated` flag is forcibly set to `false`
  regardless of what Jev reports, so it always routes to review instead of being
  silently auto-accepted.

This is a direct instance of the production doc's gate principle (§3.2): `gated`
is the actual routing decision, and a classifier's confidence is only as
trustworthy as the preprocessing that fed it.

## Key design decisions

1. **Jev as a stateless, pay-per-call decision function**, not a hosted model —
   treated like any other billed, rate-limited HTTP dependency. See
   `docs/JEV-CONTEXT.md`.
2. **Generated, versioned `criteria.json`** instead of hand-maintained labels —
   regenerate with `pnpm build-criteria`, diff before merging.
3. **Two-step disambiguation only for five rare-parent families**
   (`RARE_PARENTS` in `src/classify.ts`: 5471, 8865, 8933, 1118, 5713) — keeps
   the `state` sent to Jev minimal (the single biggest cost lever) for the other
   225+ forms, and only pays for a second call where a flat list would actually
   be ambiguous.
4. **The confidence gate is a routing decision, not just a number to log** —
   `gated: true` means "act automatically"; `gated: false` means "route to
   review." The OCR-uncertain handling above is this principle applied to a
   concrete failure mode.
5. **Bounded worker-pool concurrency, not an unbounded fan-out**, both in
   `eval/run.ts` and the UI server — sized explicitly (`CLASSIFY_CONCURRENCY`),
   not "however fast the loop goes."
6. **A hard per-run cost cap in the UI server** (`JEV_MAX_RUN_COST_USD`) — a
   runaway batch fails fast locally instead of becoming a billing surprise.

## Key dependencies

| Dependency | Used for | Required by |
|---|---|---|
| `poppler` (`pdftotext`, `pdfinfo`, `pdftoppm`) | PDF text extraction, page count, page-image rendering | `src/state.ts`, `ui/server` |
| TypeSafe Jev API | The actual classification decision | `src/backend.ts` (network, billed) |
| `tesseract.js` | OCR fallback for scanned pages (bundled WASM, no system binary) | `ui/server` only |
| `fflate` | Unzips the IRS MeF accepted-forms XLSX | `scripts/build-criteria.ts` only |

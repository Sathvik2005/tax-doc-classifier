# Updates

What this fork/commit adds on top of the original `tax-doc-classifier`, and how to
run it. `tax-doc-classifier` is, at its core, an intelligent tax-document
classifier: it reads a page of a tax PDF and tells you, with a calibrated
confidence, which of 261 IRS forms (and which of 7 page kinds) it is — using a
probability-native decision model (Jev) instead of a prompted LLM, so it's cheap
and fast enough to run on every page of every document instead of spot-checking.

## What's new here

1. **A web UI (`ui/`)** — a React + Vite frontend with a small Node backend that
   wraps the existing `classifyPage`/`jevBackend` library code. Upload a PDF, and
   every page gets classified and shown in a table: form, page kind, a confidence
   bar, and a gated (confident, act automatically) vs. review (low confidence,
   needs a human) badge. Nothing new was built into the classifier itself — the
   UI is a thin layer over the same pipeline `eval/run.ts` already exercises.
2. **A Windows path fix** — `eval/download.ts`, `eval/run.ts`, and
   `scripts/build-criteria.ts` computed their working directory with
   `new URL('.', import.meta.url).pathname`, which is broken on Windows (it
   produces `/C:/Users/...` and corrupts path joins into `C:\C:\Users\...`).
   Switched to `fileURLToPath(new URL(...))`, which is correct cross-platform.
   Without this fix, `pnpm eval:download` and `pnpm eval` simply crash on Windows.
3. **Design docs (`docs/`)**:
   - `JEV-CONTEXT.md` — the Jev/TypeSafe System One API contract, generalized so
     it's reusable in any project that needs to classify something into a closed
     set of labelled options with a real confidence number.
   - `REBUILD-METHODOLOGY.md` — how this project was actually built, generalized
     into a repeatable spec-driven method: grammar + contract test first, a
     generated (never hand-edited) dataset second, a pluggable decision backend
     third, the classification pipeline fourth, and a strict eval harness fifth —
     then iterate against the harness's own output, phase by phase, with Claude
     Code doing the implementation.
   - `JEV-PRODUCTION-SYSTEM-DESIGN.md` — what it takes to run this for real:
     concurrency/backpressure, retry/failure-class handling, idempotency, cost
     governance, the confidence gate as an actual routing decision (auto-act vs.
     review queue), observability, security/compliance for tax-sensitive data,
     CI/CD release gates, and a production checklist.

## Why it's an intelligent classifier, not just a lookup table

- It doesn't match on filenames or fixed templates — it reads the actual text of
  each page (header/body/footer) and reasons over 230+ candidate forms plus
  "not in this list," with a second, finer question only when a page lands in
  one of five large corporate/foreign form families (5471, 8865, 8933, 1118,
  5713) that would otherwise be hard to tell apart from a flat list.
- Every answer carries a calibrated confidence, not just a guess — the gate
  (`formConfidence >= 0.95` by default) is what makes it safe to automate: above
  the gate, act; below it, a human reviews. The project's own eval shows 0 wrong
  answers across 753 blank-form pages and the TaxCalcBench filled-form corpus,
  with the ~5% strict failures all being low-confidence (not wrong) edge cases
  like instruction pages that name no form.
- The "knowledge" it classifies against (`data/criteria.json`) is generated
  directly from the IRS's own published forms and schema — not hand-maintained —
  so it can be regenerated whenever the IRS revises its form set.

## Run it

Library + tests (see `README.md` for full details):
```
pnpm install
pnpm typecheck
pnpm test
```

Eval against real IRS forms (needs `TYPESAFE_API_KEY` and poppler's
`pdftotext`/`pdfinfo`):
```
pnpm eval:download
TYPESAFE_API_KEY=... pnpm eval --corpus=blank
```

Web UI — upload a PDF, see it classified page by page:
```
cd ui
pnpm install
set -a && source ../.env && set +a
pnpm dev
```
Then open http://localhost:5173.

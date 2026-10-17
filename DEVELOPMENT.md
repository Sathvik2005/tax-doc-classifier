# Development

Local setup, conventions, testing, and debugging. For system design, see
`ARCHITECTURE.md`; for the eval harness specifically, see `EVALUATION.md`.

## Prerequisites

- Node 20+ and [pnpm](https://pnpm.io)
- [poppler](https://poppler.freedesktop.org) — provides `pdftotext`, `pdfinfo`,
  and (for the web UI) `pdftoppm`.
  - macOS: `brew install poppler`
  - Debian/Ubuntu: `apt install poppler-utils`
  - Windows: available via Chocolatey (`choco install poppler`) or MSYS2.
- A TypeSafe API key (`TYPESAFE_API_KEY`) — only needed to actually call Jev
  (eval runs, the web UI). `pnpm typecheck`/`pnpm test` don't need it.

## Setup

```
pnpm install
pnpm typecheck
pnpm test
```

Put secrets in a `.env` file at the repo root (git-ignored):

```
TYPESAFE_API_KEY=...
```

Nothing loads `.env` into `process.env` automatically for plain `node`/`tsx`
invocations — either export the variable yourself, or pass
`--env-file=.env` (Node 20.6+) / `--env-file=../.env` from `ui/`, which is what
the `ui` package's `pnpm dev` scripts already do.

## Repository layout

See `ARCHITECTURE.md` for what each module is responsible for. In short:
`src/` is the library, `data/criteria.json` is generated data, `eval/` is the
scoring harness, `scripts/build-criteria.ts` regenerates the data file, and
`ui/` is the web app (its own `package.json`, installed separately).

## Coding conventions

- TypeScript throughout, `type: module` (ESM) — import local files with a
  `.js` extension even though the source is `.ts` (`./state.js`, not
  `./state.ts`), matching Node's ESM resolution.
- `data/criteria.json` is generated — never hand-edit it. Change
  `scripts/build-criteria.ts` and regenerate instead (see below).
- Form ids follow `src/ids.ts`'s grammar (`ID_GRAMMAR`) exactly; `src/ids.test.ts`
  fails the build if any id in `criteria.json` doesn't match it. If you need a
  new id shape, extend the grammar and the test first, not the data.
- Keep `state` sent to Jev minimal — it's the single biggest cost lever (see
  `docs/JEV-CONTEXT.md`'s cost/perf mental model). Don't add fields to
  `PageState` or the question criteria without a reason tied to accuracy.

## Testing

```
pnpm test          # vitest run — currently src/ids.test.ts (the grammar/contract test)
pnpm typecheck      # tsc --noEmit
```

The grammar test (`src/ids.test.ts`) is the project's contract test, per
`docs/REBUILD-METHODOLOGY.md`: it asserts every id actually in `criteria.json`
is a valid id, and that the mechanical IRS-name → id conversion is correct for
known tricky cases (schedules, suffix letters, page numbers). If you touch
`src/ids.ts` or regenerate `criteria.json`, run this before anything else.

There is no CI workflow configured in this repository yet — `pnpm typecheck`,
`pnpm test`, and (where relevant) `pnpm eval` are the three checks to run
locally before opening a PR; see `docs/JEV-PRODUCTION-SYSTEM-DESIGN.md` §6 for
what a CI/CD setup for this should eventually gate on.

## Regenerating the data file

```
pnpm build-criteria
```

Hits live IRS URLs (the MeF accepted-forms XLSX, then each form's own PDF) and
rewrites `data/criteria.json`. Re-run it when the IRS publishes new revisions.
Always diff the result and re-run `pnpm test`/`pnpm eval` before committing —
a form's title or box labels changing is meaningful.

## Debugging

- **The classifier gives a confident wrong answer**: check `probabilities` in
  the `PageResult` (surfaced in the web UI's Page Inspector) for the runner-up
  — a close second usually points at a missing/weak disambiguation hint in
  `criteria.json`'s `notFor` field for one of the two forms.
- **A scanned page comes back `blank`**: the library itself doesn't do OCR
  (see `ARCHITECTURE.md`'s OCR section) — this is expected for direct
  `classifyPage` use. In the web UI, check the server log for `OCR failed:`
  warnings, and look for `ocrUncertain: true` in the page's result.
- **`pnpm eval:download` or `pnpm eval` crashes immediately**: almost always
  poppler not on `PATH`, or `TYPESAFE_API_KEY` not set for `pnpm eval`. On
  Windows specifically, `eval/download.ts`, `eval/run.ts`, and
  `scripts/build-criteria.ts` compute their working directory with
  `fileURLToPath(new URL(...))` rather than `new URL('.', import.meta.url).pathname`
  — the latter produces `/C:/Users/...` on Windows and corrupts path joins into
  `C:\C:\Users\...`. If you're porting a change from elsewhere, keep using
  `fileURLToPath`.
- **The UI server crashes on startup with `TYPESAFE_API_KEY is not set`**:
  `.env` isn't being loaded — see Setup above.

## Contribution workflow

1. Fork/branch, make the change.
2. `pnpm typecheck && pnpm test` (and `pnpm eval` if you touched
   `src/classify.ts`, `src/backend.ts`, `data/criteria.json`, or question/
   criterion wording — post the before/after strict rate in the PR description).
3. If you touched `ui/`, also run `cd ui && pnpm typecheck && pnpm build`.
4. Open a PR describing *why*, not just *what* — especially for anything that
   changes the confidence gate, the `state` sent to Jev, or `criteria.json`.

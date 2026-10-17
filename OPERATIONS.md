# Operations

Running the web UI, configuration, logging, and troubleshooting. This covers
the UI's current single-machine, single-process deployment as it exists in
this repository — not a hosted/multi-tenant deployment, which this project
does not currently ship. For what that would additionally require, see
`docs/JEV-PRODUCTION-SYSTEM-DESIGN.md`.

## Running it

```
cd ui
pnpm install
pnpm dev
```

This runs the Vite dev server and the classify API concurrently
(`concurrently -k -n web,server "vite" "tsx watch --env-file=../.env server/index.ts"`).
Open the URL Vite prints (`http://localhost:5173` by default; Vite picks the
next free port if that one's taken).

For a production-style build of the frontend only:

```
cd ui
pnpm build       # outputs ui/dist
```

The server (`ui/server/index.ts`) is run with `tsx`/`node` directly — there is
no separate production build step for it in this repository.

## Configuration

Everything is read from environment variables, loaded from `../.env` by the
`pnpm dev` scripts (`--env-file=../.env`). The running server's resolved
config is also visible live at `GET /api/config` and the UI's Settings page.

| Variable | Default | Purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | *(required)* | Jev API key. Server fails to start without it. |
| `PORT` | `8787` | Classify API server port. |
| `JEV_CONCURRENCY` | `8` | Worker-pool size for concurrent Jev calls per classify job. Size to the vendor's actual rate limit (`docs/JEV-PRODUCTION-SYSTEM-DESIGN.md` §2.1), not a guess. |
| `OCR_WORKERS` | `4` | Number of pooled `tesseract.js` OCR workers. |
| `JEV_MAX_RUN_COST_USD` | `5` | Hard cost cap per classify job; processing stops dispatching new pages once estimated cost reaches this. |

`OLLAMA_URL`/`OLLAMA_MODEL` appear in `.env` as placeholders for a planned
local-chat feature that is **not currently implemented** in this codebase —
they are not read by any code in `ui/server` today.

## Logging

The server logs to stdout/stderr: a startup line (`classify server →
http://localhost:<port>`), and `OCR failed: <message>` warnings when a page's
OCR attempt throws. There is no structured logging, log aggregation, or
per-request logging implemented — per `docs/JEV-PRODUCTION-SYSTEM-DESIGN.md`
§4, anything beyond local development should add structured, one-line-per-unit
logging with document content/PII excluded.

## Job lifecycle and storage

Each upload creates a temp directory (`os.tmpdir()/taxdoc-ui-*`) holding the
PDF and cached per-page PNG renders, keyed by a `jobId`. This directory is
swept automatically 20 minutes after the last request that touched it (upload,
stream, or preview) — there is no manual cleanup endpoint and no persistence
beyond that TTL. Nothing is written outside the OS temp directory; no database
or external store is used.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server crashes on start: `TYPESAFE_API_KEY is not set` | `.env` not loaded | Confirm `.env` exists at the repo root and `pnpm dev` is being run from `ui/` (so `--env-file=../.env` resolves) |
| Every page classifies as `blank` | No text layer *and* OCR didn't run (e.g. page render failed) | Check server log for `OCR failed:` lines; check the page's `ocrUncertain` flag in the Page Inspector |
| Upload fails immediately with an "exceeds N bytes" error | Document over the upload limit (300 MB) | Expected guard against unbounded uploads; there is currently no config override for this limit |
| Classify stream stops partway with "cost budget exceeded" | `JEV_MAX_RUN_COST_USD` hit mid-run | Intentional hard stop (§2.4 of the production design doc) — raise the env var if the job's real cost is expected to exceed it |
| `/api/classify/:jobId/stream` or `/preview` returns 404 | Job TTL (20 min) expired, or the server restarted | Re-upload; jobs are in-memory only and do not survive a server restart |
| `pnpm dev` fails with a poppler-related error (`pdftoppm`/`pdftotext`/`pdfinfo` not found) | poppler not installed or not on `PATH` | See `DEVELOPMENT.md` prerequisites |

## Runbooks

Step-by-step procedures for the scenarios above that need more than a one-line
fix.

### Server won't start: `TYPESAFE_API_KEY is not set`

1. Confirm `.env` exists at the repo root (`ls .env` from the repo root, not
   from `ui/`).
2. Confirm it contains a `TYPESAFE_API_KEY=...` line with no surrounding quotes.
3. Confirm you're running `pnpm dev` from inside `ui/` — the dev scripts load
   `--env-file=../.env`, which resolves relative to `ui/`'s working directory.
   Running the server from the repo root instead will look for `.env` one
   level too high and fail the same way.
4. If you need the key in a shell for something other than `pnpm dev` (e.g.
   `pnpm eval` at the repo root), export it directly: `export TYPESAFE_API_KEY=...`
   (`$env:TYPESAFE_API_KEY=...` on PowerShell).

### A classify job stalls or never finishes

1. Check the server log for repeated `OCR failed:` lines — a scanned,
   OCR-heavy document with many pages can be legitimately slow (`tesseract.js`
   is CPU-bound WASM OCR, not a native binary); this is expected to take
   noticeably longer than a text-native PDF of the same length.
2. If the log shows no activity at all (not even OCR warnings), confirm the
   process is actually making progress rather than hung: check CPU usage of
   the server process. Near-zero CPU with no log output for an extended period
   indicates a genuine hang (e.g. a `pdftoppm`/`pdftotext` child process stuck)
   rather than slow OCR; restart the server and re-upload.
3. If it's cost, not time, that stopped the job, you'll see a `{"done":true,
   "budgetExceeded":true}` line at the end of the NDJSON stream and the UI
   will show "Run stopped: per-run cost budget exceeded" — this is not a hang,
   see the cost-budget runbook below.
4. For a document you expect to be large (hundreds of pages), raise
   `JEV_CONCURRENCY` cautiously (see Configuration) rather than assuming
   something is broken — confirm against your actual Jev rate limit first.

### Cost budget exceeded mid-run

1. This is the intended behavior of `JEV_MAX_RUN_COST_USD` (default $5) — it
   is a hard stop, not an error condition to "fix" by default.
2. Before raising the cap, check whether the job actually needed that much
   cost: an unusually high `inputTokens` total on a document this size can
   indicate `state` bloat (see `docs/JEV-PRODUCTION-SYSTEM-DESIGN.md` §2.4) or
   a document larger than expected.
3. If the cost is legitimate for the document's size, set
   `JEV_MAX_RUN_COST_USD` higher for that run and restart the server (env vars
   are read once at startup).
4. Re-upload — jobs do not resume from where a budget-stopped run left off;
   already-classified pages are not re-billed if you re-run the same document,
   but you will re-pay for them since there is currently no idempotency/caching
   by page content (see `ARCHITECTURE.md`'s design decisions and the
   production doc's §2.3 for the gap this leaves open).

### OCR looks broken for many/all scanned pages

1. Check the server log for `OCR failed: <message>` — this fires per page and
   the message is the underlying `tesseract.js` error.
2. If it fails for every page, suspect an environment issue (e.g. insufficient
   memory for the WASM worker pool, or a corrupted bundled OCR asset) rather
   than a per-document problem — try lowering `OCR_WORKERS` to 1 and re-testing
   a single small scanned page.
3. Confirm the page actually needs OCR in the first place — `pdftotext`
   failing silently on an encrypted or malformed (not scanned) PDF looks
   identical from the classify result's perspective. Run
   `pdftotext -layout -f 1 -l 1 <file> -` directly against the uploaded file to
   check whether the text layer is actually empty.
4. Any page where OCR could not run shows `ocrUncertain: true` in its result
   and is forced to `gated: false` — this is working as designed (see
   `ARCHITECTURE.md`'s OCR section), not a bug to suppress.

## Rollback

There is no deployed environment or release process in this repository today —
"rollback" is `git revert`/checking out a previous commit. If you regenerate
`data/criteria.json` (`pnpm build-criteria`), keep the previous committed
version revertable the same way, per `docs/JEV-PRODUCTION-SYSTEM-DESIGN.md`
§3.5/§6.

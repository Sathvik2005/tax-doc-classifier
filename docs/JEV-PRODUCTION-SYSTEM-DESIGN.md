# Integrating Jev into a real system: architecture and production design

Third doc in the set. `JEV-CONTEXT.md` is the API contract. `REBUILD-METHODOLOGY.md`
is how to build the classifier itself with a spec-driven, harness-checked loop. This
doc is what happens **around** that classifier once it has to run continuously,
unattended, on real (often sensitive) documents, at volume, for money.

---

## 1. Where Jev sits in the system

Jev is a stateless, pay-per-call decision function. It has no place to hold your data,
no notion of a "job," and no retry/queue semantics of its own — all of that is the
surrounding system's job. Treat it like any other external, billed, rate-limited HTTP
dependency (closer to a payments API than to a database), not like an embedded model.

```
                 ┌────────────────────────────────────────────────────────┐
                 │                    your service                        │
                 │                                                        │
 documents  ──▶  │  ingest → preprocess → [ cheap pre-filters ] → classify │ ──▶ Jev API
 (upload/queue)  │                              │                    │    │
                 │                        skip call for free    bounded   │
                 │                        cases (blank, etc.)   worker    │
                 │                                              pool      │
                 │                                                   │    │
                 │                                                   ▼    │
                 │                              gate on confidence ──┴──▶ act automatically
                 │                                     │                  or route to review
                 │                                     ▼                  │
                 │                          results store + audit log ────┘
                 │                                     │
                 │                        metrics: strict-proxy rate, cost,
                 │                        confidence distribution, latency
                 └────────────────────────────────────────────────────────┘
```

Two integration shapes, pick based on latency needs:

- **Synchronous, in a request path** — user uploads a doc, waits seconds for a
  classification. Fine at low volume; call Jev directly from the handler with a hard
  timeout, no queue. This is what `classifyPage` does today — it's already
  request-shaped.
- **Asynchronous, via a queue/worker pool** — batch ingestion, backfills, or anything
  where you control hundreds/thousands of pages at once. This is what `eval/run.ts`
  and `eval/download.ts` already do: a shared work queue, N workers pulling off it
  concurrently (`Promise.all(Array.from({ length: concurrency }, worker))`). That
  exact pattern is the production worker-pool shape too — the only thing that changes
  going to production is where the queue lives (in-process array → real queue: SQS,
  Cloud Tasks, BullMQ, a Postgres-backed job table, whatever you already run) and that
  failures get persisted instead of just pushed to a `missing` array.

---

## 2. Integration patterns (production hardening of the contract in `JEV-CONTEXT.md`)

### 2.1 Concurrency and backpressure
- Cap concurrency explicitly (`concurrency = 12`-style constant, not "however fast the
  loop goes") — an unbounded fan-out against a billed external API is how you get a
  surprise invoice or get rate-limited mid-run.
- Size the cap to the vendor's actual rate limit, not a guess — confirm with TypeSafe
  what concurrent-request limit applies to your key/tier, and stay under it with
  margin so a burst from another part of your system doesn't tip you over.
- If you queue via a real message broker, let the broker's consumer concurrency be the
  single knob — don't also add an in-process worker pool on top of a queue that
  already limits delivery, you'll double-cap and make throughput hard to reason about.

### 2.2 Timeouts, retries, and failure classes
Split failures into three buckets and handle each differently — collapsing them into
one `catch` is the most common production bug in HTTP integrations:

| Failure | Example | Action |
|---|---|---|
| Transient | timeout, 5xx, connection reset | Retry with backoff (the shipped `jevBackend` does linear backoff, 4 attempts — fine for low volume; move to jittered exponential backoff once you're running enough concurrent workers that synchronized retries can thundering-herd the API) |
| Terminal, billing | `402 Payment Required` | **Never retry.** Fail the job, alert someone with billing access, don't silently burn through a retry loop against a wallet that's empty |
| Terminal, caller error | malformed `questions`/`criteria`, 4xx other than 402 | Don't retry — it'll fail identically every time. Log the exact payload (minus secrets) and fix the caller |

- Set the timeout to something real for your payload size, not a guess — measure p99
  latency in a staging eval run and set the timeout a few multiples above it, not
  90s-because-that-was-the-example.
- Track retry counts as a metric. A rising retry rate is an early warning of vendor
  degradation before it becomes outright failures.

### 2.3 Idempotency
Classifying the same input twice should be cheap and safe, not a second billed call.
Key your results store by a stable hash of the actual input to Jev (the `state` you
built, not the raw file — two different raw files can normalize to the same state,
and you want to dedupe on what you're actually paying to classify). Before calling
Jev, check the store; on a hit, skip the call entirely. This matters most in
async/queue systems where redelivery is a fact of life (at-least-once queues, retried
jobs after a worker crash mid-batch).

### 2.4 Cost governance
- Emit `inputTokens`/cost per call as a metric (the shipped `AskResult.inputTokens`
  is already there — wire it to your metrics pipeline, don't just sum it at the end of
  an eval run).
- Set a hard per-run and per-day budget cap in the calling code, not just in
  TypeSafe's dashboard — a runaway loop should fail fast locally before it becomes a
  billing surprise you find out about a day later.
- Keep `state` minimal on purpose (this is the single biggest cost lever — see
  `JEV-CONTEXT.md` §"Cost/perf mental model"). In production, measure actual token
  usage per call and treat a creeping `state` size (someone added "just a bit more
  context" to a prompt template) as a regression to catch in the same way you'd catch
  a latency regression.

### 2.5 Secrets
- `TYPESAFE_API_KEY` from environment only, exactly as shipped — never accept it as a
  request parameter, never log it, never put it in an error message that could reach
  a client or a log aggregator with broad read access.
- Separate keys per environment (dev/staging/prod) so a runaway dev script can't spend
  production budget or vice versa.
- Rotate on the same schedule as your other external API keys; make sure the rotation
  runbook is written down before you need it at 2am.

---

## 3. Production architecture around the classifier

### 3.1 Preprocessing stays outside the paid boundary
Everything before the Jev call — PDF text extraction, blank-page/cover-sheet
detection, header/body/footer windowing — must stay deterministic, local, and free.
This is already the shape of `state.ts`: no network call, no model, just text
manipulation and two regex-based pre-filters. In production, treat any proposed
addition to this layer with one question: does it reduce the number of paid calls or
improve `state` quality, or does it just move logic around? Only the former belongs
here.

### 3.2 The gate decides the downstream path, not just a flag
`gated: boolean` shouldn't just get logged — it should be the literal branch point in
your pipeline:

```
gated === true   → act automatically (file it, route it, whatever "act" means for you)
gated === false  → route to a review queue, a secondary check, or a human — never
                   silently accept a low-confidence answer as if it were certain
```

Treat the review queue as a first-class part of the system, not an afterthought —
capacity-plan it (what fraction of volume lands below your gate, per `pnpm eval`'s
strict rate, and can your review process absorb that fraction at your real volume?),
and feed corrections from it back into your eval corpus (§3.4).

### 3.3 Results store and audit trail
Persist, per classified unit: the input identity (hash, not raw sensitive content, if
you can avoid re-storing it), the full result (`form`, `kind`, every step's confidence,
the full probability map, `gated`), the backend/model version, and a timestamp. You
want this for three separate reasons that production systems tend to conflate into
one underspecified "logs" table:
- **Operational debugging** — why did this one page go wrong.
- **Audit/compliance** — especially for tax documents, being able to show what the
  system decided and how confident it was, per document, per point in time.
- **Eval corpus growth** — every reviewed, corrected low-confidence or wrong case is a
  candidate to fold into your eval corpus (§3.4). This is the actual mechanism by
  which the system gets better over time in production, not prompt tweaking in a
  vacuum.

### 3.4 The eval corpus is a living production asset, not a one-time build artifact
In this repo, `eval/` is a dev-time tool you run manually. In production, treat the
pattern the same way but make it continuous:
- Every human-reviewed correction from the gate's review queue is a new labelled
  example — add it to the corpus (with consent/appropriate handling for any real
  customer data — prefer synthetic or de-identified examples over raw customer
  documents in a corpus that engineers and CI will read).
- Re-run the eval harness on a schedule (nightly/weekly) and on every change to the
  pipeline, the criteria data, or the gate threshold — a `strictRate` regression is a
  release blocker the same way a failing test is.
- Version the corpus and the `criteria.json` data file together (both are "the spec,"
  per `REBUILD-METHODOLOGY.md` §3) so a strict-rate regression can be bisected to a
  specific data or code change.

### 3.5 Data pipeline lifecycle (the generator script in production)
`build-criteria.ts` hits live IRS URLs at run time. In production:
- Run it in CI on a schedule (e.g. monthly, or triggered when the IRS publishes new
  MeF revisions for a new tax year), not ad hoc on someone's laptop.
- Diff the generated `criteria.json` against the previous committed version before
  merging — a form's title or box labels changing is meaningful and should be
  reviewed, not silently deployed.
- Gate the regeneration PR on the same `pnpm typecheck && pnpm test && pnpm eval` used
  for code changes — the grammar test alone catches malformed ids, but only a full
  eval run catches "this year's IRS PDF reworded a form's boilerplate enough that our
  disambiguation hints no longer distinguish it from its sibling."
- Never let this job write directly to the production data file/branch without that
  gate passing — treat it exactly like a code change from an untrusted external input
  (because it is one: you don't control what the IRS ships).

---

## 4. Observability

Minimum metrics to ship from day one, all of which are already computed or trivially
derivable from the existing `PageResult`/`Summary` types:

| Metric | Source | Why |
|---|---|---|
| Calls/sec, concurrency in flight | worker pool | Capacity and rate-limit headroom |
| p50/p95/p99 latency per call | wrap the `ask()` call | Timeout tuning, vendor degradation |
| Retry rate, by failure class | backend wrapper | Early warning before outright failure |
| `formConfidence` distribution | every `PageResult` | Drift detection — a shifting distribution over time, even with a stable strict rate, is often the first sign that inputs are changing |
| Gate pass rate (`gated: true` fraction) | every `PageResult` | Directly tells you review-queue load |
| Cost per unit, cumulative cost | `inputTokens` | Budget tracking, catches a `state`-bloat regression |
| Strict rate on the eval corpus | scheduled eval runs, not live traffic (you don't have ground truth on live traffic) | The actual quality signal; live-traffic confidence is a proxy, not a substitute |
| Per-label error breakdown | eval run's sorted failure list | Tells you *which* confusions are getting worse, not just that something is |

Alert on: retry-rate spike, gate-pass-rate drop (more traffic than usual falling to
review — could be a real input shift or a regression), 402/billing errors (page
someone immediately, this is a hard stop), and eval strict-rate regression beyond
whatever threshold you decide is a real regression vs. noise.

Logging: structured, one line per classified unit with the result fields above minus
the actual document content/PII — log the hash/id, not the text. Never log full page
text or `state` at any level above debug-in-a-locked-down-environment; it's the actual
sensitive content of the document.

---

## 5. Security and compliance (tax/financial documents specifically)

This domain (tax documents) is sensitive by default — treat it at the level you'd
treat any PII/financial-data pipeline, not as "just text classification":

- **Encrypt in transit and at rest** wherever raw document text or extracted `state`
  is stored, even transiently (queue payloads included).
- **Minimize retention** — if you don't need the raw page text after classification,
  don't keep it; keep the result and a content hash. Define and enforce a retention
  window explicitly rather than defaulting to "forever because storage is cheap."
- **Access control** on the results store and any review-queue UI — classification
  results reveal real financial/personal details (this is a W-2, this is a 1099-DIV
  reporting dividend income) even without the raw document attached.
- **Third-party data processing agreement** — sending page text to Jev means TypeSafe
  is a subprocessor handling your customers' tax data; confirm their data handling
  terms and get this into your own privacy documentation and any relevant DPAs before
  shipping, not after.
- **Least-privilege API keys** and rotation, per §2.5.
- Know which compliance regime actually applies to you (SOC 2 if you're selling to
  businesses, relevant state privacy law for consumer data, IRS Publication 4557
  safeguarding guidance if you're a tax preparer/software provider under IRS
  oversight) and treat this pipeline as in-scope for it — it touches the same data
  those regimes are about.

---

## 6. CI/CD and release gates

Local dev already has the right three commands (`pnpm typecheck`, `pnpm test`,
`pnpm eval`); production CI/CD should make all three non-optional and add rollout
safety on top:

1. **PR gate**: `typecheck` + `test` on every PR (fast, always). `eval` on every PR
   that touches `src/classify.ts`, `src/backend.ts`, `data/criteria.json`, or the
   question/criterion wording — post the before/after strict rate and cost as a PR
   comment so the reviewer sees the number, not just the diff.
2. **Data regeneration PRs**: as in §3.5, always gated on a full eval run with a
   visible diff against the prior run.
3. **Threshold/gate changes** (changing `gate` from 0.95 to something else): treat as
   a release with its own eval run at the new threshold, and communicate the expected
   change in review-queue volume to whoever operates that queue before it ships.
4. **Canary/shadow rollout for pipeline changes**: run the new pipeline version
   alongside the old one on a slice of real traffic (or replay recent traffic through
   both), compare gate-pass rate and result agreement, before cutting traffic over
   fully. This catches real-world drift that a static eval corpus won't — the corpus
   tells you about known cases, shadow traffic tells you about the distribution you
   actually see now.
5. **Rollback plan**: keep the previous `criteria.json` and previous pipeline version
   deployable with a single revert — since the data file is generated and versioned,
   not hand-maintained, reverting it is exactly as safe as reverting code.

---

## 7. Scaling

- Horizontal: the worker-pool pattern is embarrassingly parallel across units (pages,
  documents) — scale worker count with queue depth, capped by the vendor rate limit
  from §2.1, not by your own infrastructure limits (which are cheap to add).
- Cost scales linearly with page volume — this is a feature (you can forecast it
  precisely from expected volume × measured cost/page from `pnpm eval`), use it:
  budget alerts should be set from that multiplication, not from historical spend
  alone, so a volume spike is caught before the bill is.
- The two-step disambiguation pattern (§`JEV-CONTEXT.md` pattern 3) means cost isn't
  uniform per page — pages landing in a rare-parent family cost two calls. If you're
  forecasting cost precisely, weight by the observed rate of second-call triggers in
  your eval corpus, not just "average cost per page" from a single run.

---

## 8. Production checklist

- [ ] Jev calls run behind a bounded worker pool sized to the vendor's real rate limit
- [ ] Retries only on transient failures; 402 and other terminal errors fail fast and
      alert
- [ ] Idempotent by input hash — redelivery/retry never double-bills
- [ ] Hard cost caps enforced in code, not just monitored after the fact
- [ ] API key from environment/secret manager only, never logged, rotated on schedule,
      separate per environment
- [ ] `gated: false` always routes to a defined review path, never silently accepted
- [ ] Results persisted with confidence, probabilities, backend version, timestamp —
      not just the final label
- [ ] Reviewed corrections feed back into a growing, versioned eval corpus
- [ ] `criteria.json`/data regeneration runs in CI on a schedule, diffed and
      eval-gated before merge
- [ ] Metrics shipped: latency, retry rate, confidence distribution, gate-pass rate,
      cost, per-label error breakdown from scheduled eval runs
- [ ] Alerts on billing errors, retry-rate spikes, gate-pass-rate drops, eval
      strict-rate regressions
- [ ] No raw document text/PII in logs above a locked-down debug tier; explicit
      retention policy on stored text/state
- [ ] Subprocessor/DPA coverage confirmed for sending document text to Jev
- [ ] Canary/shadow comparison before cutting traffic to a new pipeline version or
      gate threshold
- [ ] One-command rollback for both code and generated data

# Rebuilding a Jev classifier end-to-end: spec-driven dev with an AI-native harness

How `tax-doc-classifier` was actually put together, generalized into a repeatable
method: write the spec as types + a generated ground truth + a scoring harness
*before* the classification logic, then use Claude Code to fill in the logic against
that harness instead of against your own judgment. Use this doc as the blueprint to
rebuild this project, or to build the next N-option classifier the same way.

Pairs with `JEV-CONTEXT.md` (the Jev API contract) — this doc is the *process* around
it.

---

## 1. The pattern, in one paragraph

Most "classify X into one of N labels" projects fail by skipping straight to prompting
an LLM and eyeballing a few outputs. This project instead treats classification as an
engineering problem with a spec: (1) a **grammar** for what a valid label looks like,
checked by a test, (2) a **generated, versioned dataset** describing every label,
produced mechanically from an authoritative source, never hand-written, (3) a
**pluggable decision backend** behind a one-method interface, (4) a **strict scoring
harness** that is the actual acceptance criterion, and (5) classification logic that
is written and iterated against that harness's numbers, not against vibes. Claude Code
is the implementer inside this loop — it's most useful once the harness exists,
because then "does this change help" is a number, not an opinion.

```
authoritative source ──(generator script)──▶ data/*.json  (spec, generated, never hand-edited)
                                                    │
grammar + contract tests ◀─────────────────────────┤
                                                    ▼
                                          classification pipeline
                                                    │
                                                    ▼
                                      pluggable decision backend (Jev)
                                                    │
                                                    ▼
                                        eval harness → strict score, cost
                                                    │
                                                    ▼
                                     iterate pipeline/prompts against the number
```

---

## 2. Reference architecture (this repo, layer by layer)

| Layer | File(s) | What it does | Why it's a separate layer |
|---|---|---|---|
| 0. Ground truth source | IRS MeF XLSX + per-form PDFs | The authority for what labels exist and what they look like | Never trust a hand-maintained list of options — it drifts from reality |
| 1. Grammar | `src/ids.ts` (`ID_GRAMMAR`), `src/ids.test.ts` | Defines what a valid label id *is*, mechanically, both directions | A regex + round-trip test catches data-generation bugs before they reach the model |
| 2. Generated spec data | `scripts/build-criteria.ts` → `data/criteria.json` | Reads layer 0, emits one entry per label: printed name, title, page count, parent, confusable siblings | The dataset **is** the spec for "what are the options and how do I tell them apart" — regenerate it, don't edit it |
| 3. Backend abstraction | `src/backend.ts` (`Backend` interface + `jevBackend`) | One method, `ask(state, questions) → probabilities`, decoupled from the specific vendor | Lets you swap decision models without touching classification logic |
| 4. Classification pipeline | `src/classify.ts` | Turns raw input into `state`, builds questions from the generated data, applies the multi-step/gating pattern, returns a typed result | This is the only layer that's genuinely "logic" — everything else is either data or a dumb HTTP call |
| 5. Scoring/eval harness | `src/score.ts`, `eval/run.ts`, `eval/download.ts` | Defines what "correct" and "strict" mean, runs the pipeline over a real corpus, reports error rate + cost | This *is* the spec's acceptance test — a PR that doesn't move this number in the right direction isn't done |
| 6. Public surface | `src/index.ts` | One barrel export of exactly what downstream code is allowed to depend on | Keeps the internal pipeline free to change without breaking consumers |

Cross-cutting: `src/state.ts` normalizes raw input (PDF → text → header/body/footer) and
handles the trivial cases (blank, cover sheet) *before* anything reaches the model —
cheap, deterministic pre-filters belong outside the paid decision step.

---

## 3. What "spec-driven" means here concretely

Traditional spec-driven dev: write a spec doc, then implement against it. That decays
the moment the spec and the code disagree, because nothing enforces it. This project's
version fixes that by making the spec **executable** in three places:

1. **The grammar is the spec for "what is a valid label."**
   `ID_GRAMMAR` in `ids.ts` plus a test that asserts every id in the generated dataset
   matches it (`ids.test.ts`). If someone edits the generator and produces a
   malformed id, the test suite — not a reviewer — catches it.

2. **The generated dataset is the spec for "what are the options."**
   `data/criteria.json` is never hand-edited (the README says so explicitly, and
   nothing in the pipeline reads any other source of label descriptions). Re-running
   `pnpm build-criteria` is how the spec gets updated when the domain changes (IRS
   publishes new forms). This means the spec can't silently drift from the code that
   produced it — regenerating it *is* re-deriving the spec.

3. **The eval harness is the spec for "what counts as working."**
   `pnpm eval` defines correctness as strict: wrong **or** under-confident both count
   as failures. That single number (`strictRate`) plus cost is the actual definition
   of done. Not "looks right on the three examples I tried."

The practical consequence: before writing any classification logic, you should be able
to answer "what is a valid option," "what are all the options," and "how will I know
if a change made things better or worse" — each with a command you can run, not a
paragraph you have to re-read.

---

## 4. Build order (the actual sequence to follow, and to hand Claude Code)

Build in this order. Each phase produces something the next phase can be checked
against — don't jump ahead to the pipeline before the harness exists, or you'll be
iterating blind.

### Phase 0 — Decide the domain contract
- What is a "label"? (here: an IRS form id)
- What is a "page kind"? (fixed small enum, independent of the label)
- What does a raw input unit look like? (one page of text)
- Write this as TypeScript types first, no implementation. This is `Criterion`,
  `ChoiceQuestion`, `PageResult`, `Criteria` in this repo — types written before any
  function that produces or consumes them.

### Phase 1 — Grammar + contract test
- Write the id/label grammar as a single regex or parser, plus pure functions to
  go label ↔ human name in both directions.
- Write the test *first*: "every generated id matches the grammar," "every printed
  name round-trips." This test will fail until Phase 2 exists — that's fine, it's the
  target.

### Phase 2 — Generator script (the spec, made data)
- Pull from the authoritative source (an official list, a schema, a site — whatever
  is ground truth for your domain).
- Emit one JSON entry per label with whatever a decision model needs to tell it apart
  from its neighbors (title, examples, explicit "not this, not that" hints for known
  confusions — see `notFor` in `criteria.json`, generated by grouping siblings and
  listing them as disambiguators).
- Run it. Run the Phase 1 test against the output. Fix the generator, not the data,
  until it passes.

### Phase 3 — Backend abstraction
- Define the one-method interface (`ask(state, questions) → probabilities`) before
  wiring up any real vendor.
- Implement the real backend (Jev — see `JEV-CONTEXT.md`) behind it: retries, timeout,
  error classification (e.g. don't retry a billing error), nothing else.

### Phase 4 — Classification pipeline
- Turn a raw unit into `state` (cheap, deterministic, no model call).
- Short-circuit the free cases before paying for a call (blank input, trivially
  obvious cases).
- Build the question(s) from the Phase 2 data. If the option set is large and
  hierarchical, use the two-step pattern (coarse first, fine only when needed) —
  see `JEV-CONTEXT.md` pattern 3.
- Gate on confidence; return a typed result that includes *which* step was weakest,
  not just the final answer.

### Phase 5 — Eval harness
- Get or build a corpus with known-correct labels per unit.
- Define "correct" and "strict" (correct AND confident enough) as code, not prose.
- Run the full pipeline over the corpus, report error rate, cost, and — critically —
  print every failure with its confidence and runner-up, sorted worst-first. That
  sorted failure list is what you actually read when iterating.

### Phase 6 — Public surface + tests
- One barrel file exporting exactly the supported API.
- `pnpm typecheck && pnpm test` as the fast local gate; `pnpm eval` as the slow,
  ground-truth gate.

---

## 5. Running this as an AI-native loop with Claude Code

The harness is what makes Claude Code effective here instead of just fast. Without it,
"iterate on the classifier" means re-reading prompts and guessing. With it, the loop
is: change something → run the harness → read the sorted failure list → change the
thing that's actually causing the worst failures.

### 5.1 Set up a `CLAUDE.md` that encodes the contract, not just the codebase
Include, tersely:
- The layering table from §2 and which files are generated vs. hand-written
  (**never edit `data/criteria.json` by hand** — regenerate it — is exactly the kind
  of rule that belongs in `CLAUDE.md`, because it's invisible from reading the file
  itself).
- The commands that are the actual spec: `pnpm typecheck`, `pnpm test`, `pnpm eval`.
- The definition of done: strict error rate and cost, not "the code looks reasonable."
- Pointer to `JEV-CONTEXT.md` for the backend contract so Claude doesn't reinvent it.

### 5.2 Sequence prompts by phase, and give Claude the harness before the logic
Don't ask for "build the classifier" in one shot. Ask in the Phase 0–6 order above,
and for each phase, tell Claude what already exists and what command proves the phase
worked:

```
Phase 1: Write ID_GRAMMAR and the id<->name round-trip functions in src/ids.ts,
plus a vitest test that (a) asserts every id in data/criteria.json matches the
grammar and (b) round-trips a handful of known-tricky names. data/criteria.json
doesn't exist yet — the test should fail on (a) until Phase 2. Don't write Phase 2.
```

```
Phase 5: Implement eval/run.ts. It must: load data/criteria.json, run classifyPage
over every page of every corpus file, score each as wrong/strict per src/score.ts,
and print a summary line plus every strict failure sorted by ascending confidence
with its truth, predicted label, confidence, and kind. Definition of done: `pnpm eval`
runs to completion and prints that sorted list, even if the strict rate is bad —
we're building the instrument, not tuning it yet.
```

Then, once the harness exists, hand Claude the *result* as the next prompt instead of
a new spec:

```
`pnpm eval` gives 12% strict errors. The top failures are all instruction pages of
schedules being classified as their parent form. Read the sorted failure list in the
last run's output, look at 3 of the actual PDF pages that failed, and adjust the
FORM_INSTRUCTIONS wording and/or the per-label `not_for` hints to fix this class of
error specifically. Re-run `pnpm eval` and report the before/after strict rate.
```

This is the core move: **the prompt after the harness exists cites the harness's own
output**, not a restated intent. That keeps Claude's iteration grounded in the same
evidence you'd use yourself.

### 5.3 Use subagents where phases are actually independent
Phases 1–2 (grammar + generator) and Phase 3 (backend abstraction) don't depend on
each other and can be built in parallel by separate agents/forks, then merged before
Phase 4. Phase 4 (pipeline) and Phase 5 (harness) are sequential — you need the
pipeline's exact `PageResult` shape before the harness can score it, so don't
parallelize those two.

### 5.4 Treat eval output as the code review
When Claude reports "I changed X," the acceptance check is always: run `pnpm eval`
(or the relevant subset), compare strict rate and cost to the prior run, and only
accept the change if the number moved the right way or the regression is understood
and acceptable (e.g. cost went up slightly but a real error class got fixed). Keep
prior `eval/results/*.json` runs around — they're your regression baseline, not just
logs.

---

## 6. Definition of done checklist

- [ ] Grammar exists as code + a test that fails on any malformed generated id
- [ ] Dataset is 100% generated from an authoritative source; nothing about a label
      is hand-typed into the repo
- [ ] Regenerating the dataset and re-running tests is a single documented command
- [ ] Decision backend is behind a one-method interface; the real vendor call is the
      only thing that knows about HTTP/auth/retries
- [ ] Classification pipeline short-circuits free cases before any paid call
- [ ] Every result carries a confidence and a gate, not just a top answer
- [ ] Eval harness defines "strict" as code and prints failures worst-first with
      enough detail (truth, prediction, confidence, runner-up) to act on
- [ ] `pnpm typecheck && pnpm test && pnpm eval` is the whole acceptance gate
- [ ] `CLAUDE.md` states which files are generated (do not hand-edit) and what the
      three gate commands are

---

## 7. Generalizing beyond tax forms

Swap in any domain that reduces to "pick one of N well-described, mostly-static
options, from a chunk of text or structured input, and I need a real confidence
number":

| This project | Generalized |
|---|---|
| IRS MeF XLSX + form PDFs | Any authoritative list + per-item source docs (a product catalog, a support-ticket taxonomy from your own historical tags, a regulatory code list) |
| IRS form id grammar | Your label's id scheme — pick one, write the regex, test it |
| `data/criteria.json` | Your generated per-label description file |
| page text (header/body/footer) | Whatever "state" your decision needs — keep it small, it's paid input |
| 5 rare parent forms → 2-step | Any case where a flat option list is dominated by a few families with many rare children |
| TaxCalcBench + blank IRS forms | Your own labelled corpus — even a small one is enough to start the loop; grow it as you find failure classes |
| `pnpm eval` strict rate | Your own strict definition — decide up front whether "confident but wrong" and "correct but unsure" both count as failures (this project treats both as failures, deliberately, because a silent low-confidence pass-through is a hidden cost downstream) |

The method doesn't change: grammar and test first, generated data second, pluggable
backend third, pipeline fourth, harness fifth — then let Claude Code iterate against
the harness's own output, phase by phase, never against a single "build the whole
thing" prompt.

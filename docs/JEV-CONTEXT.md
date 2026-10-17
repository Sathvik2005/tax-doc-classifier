# Using Jev (TypeSafe System One) — reusable context

Drop this file into any project's docs/context when you want to classify something
against a fixed set of labelled options with a calibrated confidence, instead of
prompting an LLM for free text. Extracted from `tax-doc-classifier`'s `src/backend.ts`
and `src/classify.ts`, generalized.

## What Jev is

Jev is TypeSafe's "System One" decision model. It is **not** a chat/completion LLM:
you give it a `state` (arbitrary context describing the thing you're classifying) and
one or more `questions`, each with a closed set of labelled `criteria`, and it returns
a **probability distribution over the options** for each question — never free text.
That makes it cheap, fast, and gives you a real confidence number to gate on.

Use it for: classification, routing, tagging, triage — anything that reduces to
"pick one of N known options" where you can describe each option in a sentence or two.

Don't use it for: open-ended generation, anything where the option set isn't fixed
in advance, or anything needing reasoning chains/tool use.

## Setup

```
export TYPESAFE_API_KEY=…
```

Get a key at [typesafe.ai](https://typesafe.ai). Never log it or write it to disk;
read it from the environment only.

## The contract

```ts
export type Criterion = { what: string; examples?: string[]; not_for?: string }
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, Criterion> }
export type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> }
export type AskResult = { answers: Record<string, ChoiceAnswer>; inputTokens: number }

export interface Backend {
  ask(state: unknown, questions: Record<string, ChoiceQuestion>): Promise<AskResult>
}
```

- `state` — whatever context the model needs to decide (a page of text, a support
  ticket body, a transaction record, ...). Keep it tight; you pay per input token.
- `questions` — a map of question-key → `ChoiceQuestion`. **You can ask several
  questions about the same state in one request** — one HTTP call, one cost — as long
  as they don't depend on each other's answers.
- `criteria` — the option set for a question, keyed by the label you want back as
  `choice`. Each option gets:
  - `what` — a one-line description of the option (the main signal the model uses)
  - `examples` — optional short strings that look like real instances of this option
  - `not_for` — optional disambiguation hint ("Not X, Y" for options the model tends
    to confuse this one with)
- The response gives, per question, a `choice` (the winning key), its `confidence`
  (0–1), and the full `probabilities` map over every option — keep the full map if
  you want to show a runner-up or do your own gating logic later.

## Minimal backend implementation

```ts
export function jevBackend(opts: { apiKey?: string; model?: string; baseUrl?: string; timeoutMs?: number; retries?: number } = {}): Backend {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set')
  const model = opts.model ?? 'jev-latest'
  const url = `${opts.baseUrl ?? 'https://api.typesafe.ai'}/v1/systemone`
  const timeoutMs = opts.timeoutMs ?? 90_000
  const retries = opts.retries ?? 4
  return {
    async ask(state, questions) {
      const body = JSON.stringify({ model, state, questions })
      let lastErr: unknown
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (res.status === 402) throw new Error('TypeSafe: payment required (402)')
          if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
          const json = (await res.json()) as { answers: Record<string, ChoiceAnswer>; usage: { input_tokens: number } }
          return { answers: json.answers, inputTokens: json.usage?.input_tokens ?? 0 }
        } catch (err) {
          lastErr = err
          if (err instanceof Error && /402/.test(err.message)) throw err // don't retry billing errors
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))) // linear backoff
        }
      }
      throw lastErr
    },
  }
}
```

Endpoint: `POST https://api.typesafe.ai/v1/systemone`
Body: `{ model, state, questions }`
Response: `{ answers: Record<questionKey, ChoiceAnswer>, usage: { input_tokens } }`

## Patterns worth reusing

**1. Confidence gating instead of trusting the top answer blindly.**
```ts
const gate = 0.95
const gated = confidence >= gate
// above the gate: act automatically; below: fall back to a human or a slower path
```

**2. Skip the call entirely when the answer is free.**
If your input trivially falls into one bucket (e.g. empty/blank input), short-circuit
before calling the API — don't pay for what you can decide locally.

**3. Two-step disambiguation for large or hierarchical option sets.**
Don't cram hundreds of fine-grained options into one question if many of them are
rare siblings under a few common parents. Ask a coarse first question (parent
families + `not_in_this_list`), and only fire a second, small, focused question when
the first answer lands on a family that actually has sub-options:

```ts
const r1 = await backend.ask(state, { category: { type: 'choice', instructions, criteria: topLevelCriteria } })
const top = r1.answers.category.choice
if (NEEDS_SUBQUESTION.has(top)) {
  const r2 = await backend.ask(state, { sub: { type: 'choice', instructions: subInstructions, criteria: subCriteriaFor(top) } })
  // overall confidence = min(step confidences) — the whole chain is only as
  // confident as its weakest step
}
```

**4. Always include an escape-hatch option** (`not_in_this_list`, `other`, `none_of_these`)
in every question's criteria — a closed option set otherwise forces a wrong answer
when the true answer isn't a listed option.

**5. Multiple independent questions in one request** are essentially free relative to
a second HTTP round trip — batch what you can (e.g. "what category" and "what kind of
document" about the same state) instead of chaining separate calls.

## Cost/perf mental model

Priced per input token, no separate output-token cost (probabilities, not generated
text) — batching questions and keeping `state` small is the main lever. Typical
latency is sub-second warm; compare against an equivalent prompted-LLM classifier by
holding the corpus, machine, and hour constant — different requests don't share a
prompt cache the way one big system prompt does, so per-request state size matters
more than it would with a chat model.

## Plugging in a different backend later

Keep your call sites against the `Backend` interface above, not against `jevBackend`
directly. Anything that can return calibrated probabilities over a labelled option
set (a fine-tuned classifier, a different vendor, a local model) can implement it as
a drop-in replacement without touching the questions/criteria you've already written.

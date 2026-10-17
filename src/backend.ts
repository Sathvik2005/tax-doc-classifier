export type Criterion = { what: string; examples?: string[]; not_for?: string }
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, Criterion> }
export type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> }
export type AskResult = { answers: Record<string, ChoiceAnswer>; inputTokens: number }

export interface Backend {
  ask(state: unknown, questions: Record<string, ChoiceQuestion>): Promise<AskResult>
}

export type JevOptions = {
  apiKey?: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  retries?: number
}

export function jevBackend(opts: JevOptions = {}): Backend {
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
          if (err instanceof Error && /402/.test(err.message)) throw err
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        }
      }
      throw lastErr
    },
  }
}

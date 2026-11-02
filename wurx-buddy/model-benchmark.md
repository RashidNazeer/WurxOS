# Buddy chat models: free-only benchmark (2026-11-02)

Owner rule: Buddy uses FREE model APIs only; a wrong answer is worse than a slow one.
This is the evidence behind migration `431_buddy_free_models_only.sql` and the order in
`ai_assistant_config`.

## How the benchmark was run

`node --experimental-strip-types wurx-buddy/scripts/bench-models.mjs <env> <out.json> <slot:model,...> [q1,q3,...]`

- The real Buddy flow: Buddy's own system prompt (`agent/prompt.ts`), all 21 tool definitions
  (`agent/tools.ts`), streaming, the same adapters (`llm/chat.ts`, `llm/openai.ts`) and the same
  per-model extras (Nemotron thinking switch). Tool results are fixed fixtures wrapped as `<data id="D1">`.
- 13 questions (`q1`..`q13`): APC ranking, Team Lead ranking, brand GMV, week-on-week, attendance,
  WFH how-to from the KB, a former employee, brand assignments, top creators, a salary question the
  tool refuses, "best APC and why", list of APCs, and a TikTok question the search finds nothing for.
- The performance fixture is the real shape: APCs 89 / 83 / 82, a former employee (Ali Ahmad) under
  "NOT ranked", Team Leads 62 / 61 and one withheld.
- Keys from `.env.dev` (dev keys, free tiers). Modest volume: 4-9 s between calls, 20-45 s for Groq.
- Faithfulness was scored by reading the answers against the fixtures (plus a script that lists
  numbers and capitalised names that appear nowhere in the fixtures or the prompt). Derived arithmetic
  (+$2,365.50, +23.4%) is correct and not counted.

## Results

`ok` = answers that arrived; `err` = 429/413/5xx/timeouts. Times are medians over the answers that arrived
(first token / whole turn, tool round trips included, fixture tools are instant).

| model (slot) | n | ok | err | first token | total | right tool | unsupported claims seen |
|---|---|---|---|---|---|---|---|
| gemini-3.5-flash-lite (gemini) | 13 | 10 | 3x 429 | 3.1 s | 4.2 s | 10/10 | expands "APC" as "Affiliate Promotion Coordinator"; "November ratings are not yet complete"; q13 ends with no text after 4 searches |
| gemini-3.6-flash (gemini) | 13 | 5 | 8x 429 | 5.6 s | 6.1 s | 5/5 | none found (most careful); cites the right [D#]; slowest Gemini |
| gemini-3-flash-preview (gemini) | 6 | 5 | 1x 429 | 2.7 s | 3.6 s | 4/5 | q13 ended with no text after 7 searches; salary refusal worded fine |
| gemini-flash-lite-latest (gemini) | 6 | 6 | 0 | 3.3 s | 3.6 s | 5/6 | expands "APC" |
| gemini-3.1-flash-lite (gemini) | 6 | 6 | 0 | 7.1 s | 7.4 s | 5/6 | q10 said it "couldn't find anyone named Hamza" (a tool gap, not a fixture value); q13 speculated categories |
| gemini-3.8-flash (gemini) | 4 | 0 | 3x 503, 1x no response in 60 s | - | - | - | unusable today |
| gemini-3.5-flash (gemini) | 6 | 0 | 6x 429 | - | - | - | no quota during the run |
| gemma-4-26b-a4b-it (gemini) | 6 | 0 | 400 "thinking level not supported", 429 | - | - | - | unusable with Buddy's request |
| openai/gpt-oss-120b (groq, compact 8k) | 6 | 6 | 0 (full prompt: 5x 413 + 7x 429) | 7.8 s (2 s typical, 10-18 s outliers) | 7.9 s | 6/6 | invents an example reason ("focus on reporting"); fullwidth citation brackets (already handled) |
| openai/gpt-oss-20b (groq) | 13 | 0 | 13x 429 | - | - | - | out of per-minute tokens with the full prompt |
| qwen/qwen3.8-27b (groq) | 5 | 1 | 4x 429/413 | - | - | - | limit is lower than 8k; unusable |
| gpt-6-luna (OpenAI free tier) | 13 | 8 | 5x 429 | 3.6 s | 4.3 s | 8/8 | none found; pushed back honestly when the report was older than "last week" |
| poolside/laguna-xs-2.1 (nvidia) | 13 | 13 | 0 | 2.4 s | 5.3 s | 13/13 | WORST: invented "performance flags indicating good standing", "Nov incentives data isn't available", "salary is only for the Boss (Team Lead)", expanded "APC" as "Approved Partner Contributor" |
| nvidia/nemotron-3-ultra-550b-a55b (nvidia) | 13 | 12 | 1 unreadable text tool call | 9.7 s | 11.0 s | 12/12 | expands "APC" as "Associate Performance Consultant"; "Nov ratings aren't in yet"; otherwise clean |
| google/diffusiongemma-26b-a4b-it (nvidia) | 13 | 7 | 6x no response in 60 s | 67 s | 17.8 s | 4/7 | missing tool calls, garbled openings |
| nvidia/nemotron-3-super-120b (nvidia) | - | 0 | HTTP 404 "function not found for account" | - | - | - | dead on this key |
| nvidia openai/gpt-oss-20b, meta/muse-glimmer-30b | - | 0 | no response in 30-60 s | - | - | - | unusable |

Rate-limit behaviour seen:

- **Gemini free**: per-model, per-minute. At 4 s spacing (about 15 calls a minute, 2-3 calls per question)
  `gemini-3.6-flash` and `gemini-3.5-flash-lite` answered 429 "exceeded your current quota"; at 9 s spacing
  1 in 30. A Buddy question is 2-4 model calls, so a few simultaneous users can empty one model's minute:
  the chain must spread over several Gemini models and other providers.
- **Groq free**: 8,000 tokens a minute per model. Buddy's full request is ~8.3k tokens, so the full prompt
  gets 413 or 429. With Buddy's compact mode (`agent/compact.ts`) it works, one question a minute or so.
  It is a fallback, not a primary, and not a per-role model.
- **OpenAI free tier (gpt-6-luna)**: 100,000 tokens a minute org limit already "used" by the shared pool:
  after 8 questions (about 20 model calls) it answered `rate_limit_exceeded ... try again in ~38 h`. Fast and
  faithful while it lasts. A long wait is classed as `limit`, so Buddy skips it on the following turns.
- **NVIDIA**: no 429s, but several models hang or 404. Trial-terms key.

## Findings that are not about the model

- Four models expanded the acronym "APC" into a different invented phrase each. Nothing in Buddy's
  prompt or the tool results says what APC stands for, so any model will guess. The prompt (not owned
  by the model-side work) should say "APC/IPC/TL/OL are role codes; never spell them out".
- Several models add "November ratings are not yet complete" after a tool returned October: an inference
  from today's date, not from the tool. The grounding rules should cover "do not explain why data is
  from the month it is from".

## The order (and why)

1. `gemini-3.5-flash-lite` (gemini) - fastest steady one, right tool every time.
2. `gemini-3.6-flash` (gemini) - the most careful; its own quota bucket.
3. `openai/gpt-oss-120b` (groq, compact) - a second provider.
4. `gpt-6-luna` (OpenAI free tier) - a third provider; skipped immediately while its allowance is out.
5. `gemini-3-flash-preview`, 6. `gemini-flash-lite-latest` (gemini) - more Gemini buckets.

Then the automatic safety net (`auto_failover`): remaining Gemini by rank, Groq, luna, and last NVIDIA
(`nemotron-3-ultra` before `laguna`, because laguna added claims). NVIDIA's API-catalog keys are for
prototyping and testing per NVIDIA's terms: never primary, never in the configured chain, and skipped
once a turn has read people or pay data. Benchmarked-bad NVIDIA models are excluded from the net.
No role overrides: Groq cannot carry a role, and the TL override equalled the global model.

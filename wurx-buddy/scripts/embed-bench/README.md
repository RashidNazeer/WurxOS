Embedding benchmark (2026-11-03). Order: `corpus.mjs` (export chunks, read-only on production) → `genq.mjs`
(questions written by a free LLM from chunks; add real questions + gold docs by hand) → `embed.mjs <nvidia|g1|g2>`
(vectors; Gemini is paced to 80 inputs/min and stops at its 1,000/day cap) → `evalr.mjs <dir> nvidia[,g1]`
(recall@5/10, MRR, keyword and RRF-weight variants). Gemini's free tier allows 1,000 inputs per model per day:
run it on a corpus of at most ~800 chunks, or over several days. Env keys in .env.dev: NEM_API / OPEN_AI_NVA are NVIDIA, Gemini_Fallback is Gemini.

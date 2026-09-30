-- ============================================================
-- 395 — Wurx Buddy: gpt-5.4-nano as a third model the Boss can pick.
--
-- The model allow-list lives in the function (llm/openai.ts ALLOWED_MODELS);
-- ai_assistant_config.model has no check constraint or trigger, so nothing
-- else to extend. This adds nano's price to the price table:
--   • merged into the stored prices WITHOUT overwriting an existing entry;
--   • added to the column default for fresh rows.
-- The nano price is ASSUMED ($/1M: in 0.20, cached 0.02, out 1.25), not a
-- verified list price: check it against OpenAI's price page and edit the row.
-- Idempotent.
-- ============================================================

update public.ai_assistant_config
   set prices = jsonb_build_object('gpt-5.4-nano', jsonb_build_object('in', 0.2, 'cached', 0.02, 'out', 1.25)) || prices
 where not (prices ? 'gpt-5.4-nano');

alter table public.ai_assistant_config alter column prices set default '{
  "gpt-5.4-mini":           {"in": 0.75, "cached": 0.075, "out": 4.5},
  "gpt-5.5":                {"in": 5,    "cached": 0.5,   "out": 30},
  "gpt-5.4-nano":           {"in": 0.2,  "cached": 0.02,  "out": 1.25},
  "text-embedding-3-small": {"in": 0.02, "cached": 0.02,  "out": 0}
}'::jsonb;

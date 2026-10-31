-- 0110_local_llm_price.sql — 本地 Ollama 備援（_shared/local-llm.ts）的單價列
--
-- 解卦掉到本地時 ai_usage.model 記成「local/qwen3.5:9b」這類字串。
-- 電費不算 API 成本，記 0；但要明確列出，不讓它掉進 ai_cost() 的 unpriced（見 0043 設計第二條）。
insert into model_prices (model_prefix, usd_in, usd_cache_write, usd_cache_read, usd_out, note) values
  ('local/', 0.0000, 0.0000, 0.0000, 0.0000, '六六家用 GPU（Ollama），最後一道備援')
on conflict (model_prefix) do nothing;

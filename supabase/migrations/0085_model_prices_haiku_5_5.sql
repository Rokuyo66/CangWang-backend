-- 0085_model_prices_haiku_5_5.sql — 新模型單價（閒聊可改用 Haiku 5.5 並先想再答）
-- 每百萬 token 美元；快取寫入以 1h TTL 計（輸入價 2 倍），讀取為輸入價 0.1 倍。
-- Haiku 5.5：提示超過 100K token 另有較高價，閒聊用不到。
insert into model_prices (model_prefix, usd_in, usd_cache_write, usd_cache_read, usd_out, note) values
  ('claude-haiku-5-5',  0.1000, 0.2000, 0.0100, 0.5000, '閒聊候選：先想再答（adaptive thinking），想的部分照輸出價'),
  ('claude-sonnet-5-5', 2.0000, 4.0000, 0.2000, 10.0000, '備查')
on conflict (model_prefix) do nothing;

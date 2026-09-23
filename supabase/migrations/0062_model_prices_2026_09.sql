-- 0062_model_prices_2026_09.sql — 單價表對齊 2026-09 官方價目
--
-- 一、Sonnet 5：0043 寫的是「導入價 $2/$10 至 2026-08-31，之後回 $3/$15」，照舊價填。
--     官方已宣布 $2/$10 轉為正式定價、9/1 的漲價取消。不改的話，切到 Sonnet 5 之後
--     ai_cost 報表會把它高估五成。usd_cache_write 沿用本表慣例＝1 小時快取寫入（2 倍輸入價）。
--
-- 二、Opus 5.5：新增一列。不補的話，前綴比對會掉到 claude-opus-5 那列、以 $5/$25 計價
--     （實際 $4/$20），而且不會出現在 unpriced——是「算錯」而不是「沒算」，更難發現。
--     快取讀取是輸入價的 0.05 倍（其餘模型 0.1 倍），所以是 0.20 不是 0.40。
--     目前未使用：它的思考關不掉，跟本站短輸出上限相衝，見 services.ts thinkingOnByDefault。

update model_prices
   set usd_in = 2.0000, usd_cache_write = 4.0000, usd_cache_read = 0.2000, usd_out = 10.0000,
       note = '$2/$10 已轉正式定價（原定 2026-09-01 漲價取消）'
 where model_prefix = 'claude-sonnet-5';

insert into model_prices (model_prefix, usd_in, usd_cache_write, usd_cache_read, usd_out, note) values
  ('claude-opus-5-5', 4.0000, 8.0000, 0.2000, 20.0000, '未使用，備查；快取讀取 0.05 倍')
on conflict (model_prefix) do nothing;

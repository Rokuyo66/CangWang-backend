-- 0104_ai_usage_latency.sql — 每一次解卦花了多久（六六 2026-10-22：有人說批卦變慢，卻查不到是哪天、哪個模型）。
-- interpret 解卦（起卦、追問、評卦、完整卦理、日運、月誌）量從送出到拿到整段回覆的毫秒數，含備援重打。
-- 查法：select date_trunc('day', created_at) d, model, count(*), round(avg(latency_ms)) avg_ms,
--        percentile_cont(0.9) within group (order by latency_ms) p90_ms
--        from ai_usage where latency_ms is not null and created_at > now() - interval '7 days' group by 1,2 order by 1 desc;
alter table ai_usage add column if not exists latency_ms int;
comment on column ai_usage.latency_ms is '這一次 AI 呼叫的耗時（毫秒，含備援重打）；0104 之前的紀錄是空的';

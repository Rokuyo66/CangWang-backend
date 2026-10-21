-- 0098_jianghu_stats.sql — 江湖四項數值的名字放進設定（六六 2026-10-21：義／明／勢／緣不直觀，改 正氣／眼力／名聲／人緣）
-- App 演出時畫在畫面上，選了之後那一格浮出 +1。要改名字就改這一格（k 不能動：劇本裡記的是 s1～s4）。
alter table jianghu_config add column if not exists stats jsonb not null default
  '[{"k":"s1","name":"正氣"},{"k":"s2","name":"眼力"},{"k":"s3","name":"名聲"},{"k":"s4","name":"人緣"}]'::jsonb;
comment on column jianghu_config.stats is '四項數值的名字（k 固定 s1～s4，name 可改）。App 演出時顯示';

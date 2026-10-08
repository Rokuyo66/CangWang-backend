-- ============================================================
-- 0078_memory_kinds_and_days.sql
-- 記憶分三類、記事情那天；起居注（三人自己過的日子）
--
-- 回報（六六 2026-09-30）：記憶彙整之後出事——時間過很久了，角色還當他在那個狀態裡，
-- 用對應的怪語氣回話；而且日期沒抓到。另外，角色只活在他的記憶裡，他不來觀裡就不動。
--
-- 一、character_memories 加兩欄（見 functions/_shared/memkind.ts）：
--     kind        trait 其人／event 事件／state 狀態。舊資料留空，讀的時候用字判。
--     happened_on 事情發生那天。舊資料留空，退回 created_at（彙整那天，會晚幾天）。
--   狀態超過七天就不注入對話（釘選的除外），記憶頁照樣列出、標成淡去。
--
-- 二、character_days：起居注，一天一列 × 三人，全站共用（見 functions/_shared/days.ts）。
--   due-reminder 每天寫；沒寫到的話，第一個來聊天的人在背景補寫。
--   RLS 全鎖：一律走 interpret／due-reminder（service role）。
-- ============================================================

alter table character_memories add column if not exists kind text
  check (kind is null or kind in ('trait', 'event', 'state'));
alter table character_memories add column if not exists happened_on date;

create table if not exists character_days (
  day          date not null,
  character_id text not null,
  body         text not null,
  created_at   timestamptz not null default now(),
  primary key (day, character_id)
);
alter table character_days enable row level security;

comment on table character_days is
  '起居注：三人每天自己過的小事，一天一次寫三人，讀前幾天的接上前後。全站共用，談心時注入。';

-- 驗收：
-- select column_name from information_schema.columns
--  where table_name = 'character_memories' and column_name in ('kind','happened_on');   -- 應回 2 列
-- select * from character_days order by day desc limit 6;                               -- 部署後聊一句就會有今天的

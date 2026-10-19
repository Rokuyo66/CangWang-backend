-- 0093_mailbot_inbox_zero.sql — 收件匣清零：歸檔卡片與自建分類
--
-- 一、mailbot_seen 多三欄，給 TG 歸檔卡用：
--     options：卡上的標籤選項（⭐推薦在第一個）。按鈕只帶「第幾個」，標籤名存這裡——
--              callback_data 上限 64 bytes，塞不下中文標籤；而且清單日後變了，舊卡按下去也不會放錯地方
--     suggest：AI 建議的新分類（現有的都不合適時）
--     summary：一句話摘要，/mailask 重推卡片時用
-- 二、mailbot_labels：觀主在 TG 按「🆕 新分類」開出來的標籤。固定清單寫在 mailbot.ts 的 LABELS，
--     這張表只記額外的；AI 分類與到期清理都會把它們納入（到期日看名稱開頭：三月／五年／永久）。

alter table mailbot_seen add column if not exists options text[];
alter table mailbot_seen add column if not exists suggest text;
alter table mailbot_seen add column if not exists summary text;

create table if not exists mailbot_labels (
  name       text primary key check (name ~ '^(三月|五年|永久)/.{2,8}$'),
  note       text,
  created_at timestamptz not null default now()
);
alter table mailbot_labels enable row level security;

-- Supabase 2026-10-30 起 public 新表不自動授權（見 0092 檔頭）
grant select, insert, update, delete on mailbot_labels to service_role;

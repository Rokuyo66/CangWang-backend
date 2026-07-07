-- 0008_due_reminder.sql — 應期到期回訪推播（只加欄位；排程另在後台手動設）
alter table feedback add column if not exists reminded_at timestamptz;

-- 0105_miss_nudge.sql — 應期「沒準」提醒（六六 2026-10-23）。
-- 最近 5 次回評裡「沒準」（部分準算半次）到 3，由最常替他起卦的那一位跳出對話彈窗，提醒換起卦方式、靜心、建立儀式。
-- 看過的時間記在這裡；30 天內不再提醒。規則在 supabase/functions/_shared/miss-nudge.ts。
alter table profiles add column if not exists miss_nudge_seen_at timestamptz;
comment on column profiles.miss_nudge_seen_at is '上次看「沒準」提醒的時間；30 天內不再跳。null＝沒看過';

-- 0105_miss_nudge.sql — 應期「沒準」累積提醒（六六 2026-10-23）。
-- 「沒準」（feedback.verdict = 3）超過 5 次，由最常替他起卦的那一位跳出對話彈窗，提醒換起卦方式、靜心、建立儀式。
-- 看過那一刻的「沒準」次數記在這裡；再多 5 次才再提醒。規則在 supabase/functions/_shared/miss-nudge.ts。
alter table profiles add column if not exists miss_nudge_at int;
comment on column profiles.miss_nudge_at is '上次看「沒準」提醒時，累計的沒準次數；null＝沒看過';

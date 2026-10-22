-- 0102_reminder_voice.sql — 提醒用角色的口吻說（六六 2026-10-22）
-- 存提醒時由 Haiku 寫好一句（_shared/reminder-voice.ts），手機的通知就用這一句、配那位角色的頭像。
alter table reminders add column if not exists voice text;
comment on column reminders.voice is '提醒那一句（角色口吻），存提醒時寫好；空＝舊資料，通知退回用 title';
-- 舊資料裡「隨機」存成空值的，抽定一位：空值的話閒聊不會提起、通知也不知道該用誰的臉
update reminders set character_id = (array['daoshi_m','daoshi_f','lingshou'])[1 + floor(random() * 3)::int]
 where character_id is null;

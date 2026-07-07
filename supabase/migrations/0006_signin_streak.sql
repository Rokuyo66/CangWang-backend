-- 0006_signin_streak.sql — 七日循環簽到
-- 記在 profiles：上次簽到日、連續天數
alter table profiles add column if not exists last_sign_date date;
alter table profiles add column if not exists sign_streak smallint not null default 0;

-- tg_sessions：記今天是否已提醒過簽到（避免重複提醒）
alter table tg_sessions add column if not exists sign_reminded date;

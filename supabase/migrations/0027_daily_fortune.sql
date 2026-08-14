-- 0027 每日運勢卦
-- 免費日運卦的每日一次閘門。獨立額度，不吃 free_quota 的每日三卦。
-- 向後相容：純加欄位，舊資料為 null＝從未領過，第一次點就給。
alter table profiles add column if not exists last_fortune_date date;

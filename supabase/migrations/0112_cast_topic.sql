-- 0112 casts.topic：問事分流的事類（_shared/topic.ts）。
-- 初解時判定（或問卦人在 need_topic 彈窗／按鈕自己點選），追問、完整卦理、換人評卦沿用，
-- 讓同一卦後續各層帶的是同一段角色表與專斷。舊卦為 null，讀取端以問句再分流。
alter table casts add column if not exists topic text;

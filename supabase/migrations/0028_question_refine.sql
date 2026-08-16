-- 0028 問題品質流程（擬題／預檢）
-- 目的：閒聊探詢後由角色擬題、問事頁送出前預檢改寫；並保留原話以供日後統計「擬題是否提升準確率」。
-- 全部為加欄位，向後相容，舊資料一律 null。

-- casts：問句來源與原話
alter table casts add column if not exists question_raw text;        -- 玩家最初講的原話（未經擬題／改寫）
alter table casts add column if not exists question_raw_norm text;   -- 原話正規化（一事不二占雙軌比對用）
alter table casts add column if not exists question_source text;     -- chat_draft | refined | manual

create index if not exists casts_user_rawnorm_idx on casts (user_id, question_raw_norm);

-- chat_messages：本則助理回覆的機器標記（probe / draft / ask），供探詢輪次計算
alter table chat_messages add column if not exists mark text;

-- tg_sessions：TG 端擬題／預檢
-- draft_*：待玩家點頭的候選；pending_*：已點頭、配 pending_question 一起送去起卦
alter table tg_sessions add column if not exists draft_question text;   -- 角色擬好、待玩家點頭的問句
alter table tg_sessions add column if not exists draft_yong text;       -- 擬題同時取定的用神六親（可為 null）
alter table tg_sessions add column if not exists draft_opts jsonb;      -- 預檢改寫候選（最多三條）
alter table tg_sessions add column if not exists draft_raw text;        -- 候選對應的原話
alter table tg_sessions add column if not exists pending_raw text;      -- 已確認問句的原話
alter table tg_sessions add column if not exists pending_source text;   -- chat_draft | refined | manual
alter table tg_sessions add column if not exists pending_yong text;     -- 已確認問句的用神六親

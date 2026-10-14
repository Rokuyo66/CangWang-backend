-- ============================================================
-- 0087_monthly_hidden_quests.sql
-- 隱藏支線每月換一批
--
-- 六六 2026-10-14：每個月讓角色出現在非常規位置做一件非常規事，找到會出靈石獎勵信。
-- 機制沿用 0069（hidden_quests／hidden_found／hidden_quest_claim）：
--   ・month 為空＝永久支線（0069 那三條，照舊）
--   ・month＝'YYYY-MM'＝那個月才出現；月初由 due-reminder 叫模型寫三條（每位一條，見 monthly-quest.ts）
-- 每條 id 帶月份（m_2026_11），所以每個月都能再找一次；hidden_found 的主鍵照舊擋同一條找兩次。
-- ============================================================

alter table hidden_quests add column if not exists month text
  check (month is null or month ~ '^[0-9]{4}-[0-9]{2}$');
create index if not exists hidden_quests_month_idx on hidden_quests (month);
comment on column hidden_quests.month is
  '空＝永久支線；YYYY-MM＝只在那個月出現（每月由模型自動寫，見 _shared/monthly-quest.ts）。';

-- 驗收（部署後等 due-reminder 跑過一次，或手動觸發）：
-- select id, character_id, place, doing, mail_subject from hidden_quests where month = to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM');

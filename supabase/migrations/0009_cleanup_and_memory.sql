-- 0008_cleanup_and_memory.sql
-- ① 聊天長期記憶欄位（滾動彙整的存放處）
-- ② 過期且未印證的卦清理；已印證(verdict 1/2/3)者永久保留＝準驗率數據資產

-- ① 長期記憶摘要（每個 user×character 一份）
alter table user_character add column if not exists memory_summary text;

-- ② 清理函式：刪「90 天前」且「無印證結果(verdict 1/2/3)」的卦。
--    casts 的 followups / feedback 皆 on delete cascade，刪卦會自動連帶清掉。
--    回傳刪除筆數，便於排程日誌觀察。
create or replace function cleanup_expired_casts()
returns integer
language plpgsql
security definer
as $$
declare
  n integer;
begin
  with del as (
    delete from casts c
    where c.created_at < now() - interval '90 days'
      and not exists (
        select 1 from feedback f
        where f.cast_id = c.id and f.verdict in (1, 2, 3)
      )
    returning 1
  )
  select count(*) into n from del;
  return n;
end;
$$;

-- 每週清理一次（週一 03:00 UTC＝台灣 11:00，離峰）。
-- 同名 job 會被覆蓋、不重複堆疊；pg_cron 已啟用（due-reminder-daily 在用）。
-- 若 db push 時此行因權限報錯，可單獨在 Supabase SQL Editor 跑這段。
select cron.schedule(
  'cleanup-expired-casts-weekly',
  '0 3 * * 1',
  $$select cleanup_expired_casts();$$
);

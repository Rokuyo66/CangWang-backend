-- 0079_keep_xinji_casts.sql — 週清理不再刪「心事卦」
--
-- cleanup_expired_casts（0009）每週一刪「90 天前、沒有印證結果」的卦。
-- 心跡上線後，卦可以歸進一件心事（casts.thread_id），心事的留言也會引用卦（thread_notes.cast_id）。
-- 這些卦是心事的一部分：心事還在，卦就不能被清掉——否則時間軸上會缺一段，留言指向的卦也打不開
-- （thread_notes.cast_id 是 on delete set null，刪了只剩一則沒頭沒尾的留言）。（六六 2026-10-05：心事卦不刪）
--
-- 規則：以下任一成立就保留
--   ① 有印證結果（feedback.verdict 1/2/3）——原本就保留，準驗率的數據資產
--   ② 歸在某件心事裡（casts.thread_id 不是 null）
--   ③ 被心事的留言引用（thread_notes.cast_id）
-- 心事本身被刪了，thread_id 會變 null（0045：on delete set null），那張卦就回到一般規則。
--
-- 權限：create or replace 保留既有的 grant（0036 已收掉對外呼叫，只剩 service role），
-- 這裡再明確收一次，避免哪天有人用 drop + create 重建時漏掉。

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
      and c.thread_id is null
      and not exists (
        select 1 from feedback f
        where f.cast_id = c.id and f.verdict in (1, 2, 3)
      )
      and not exists (
        select 1 from thread_notes tn
        where tn.cast_id = c.id
      )
    returning 1
  )
  select count(*) into n from del;
  return n;
end;
$$;

revoke execute on function cleanup_expired_casts() from public, anon, authenticated;
grant execute on function cleanup_expired_casts() to service_role;

-- 「被留言引用」那一條要查 thread_notes.cast_id：補索引，週清理掃全表時才不會慢
create index if not exists thread_notes_cast on thread_notes (cast_id) where cast_id is not null;

-- ============================================================
-- 0115_chat_expired_pairs.sql
-- 閒聊明細過期清理：點名＋每組一把短鎖
--
-- 六六 2026-11-03：「隔很久回來他還在講好幾週以前的事」。超過一天的閒聊收成回憶後刪掉；
-- 不聊的人也要清，但不要海巡——只撈真的有過期明細的那幾組，一天一次、每次封頂（due-reminder 叫）。
-- 收的動作要呼叫模型，所以在 edge function（chat.ts 的 condenseMemory／sweepExpiredChats）做，這裡只負責點名與上鎖。
-- 全部只給 service_role。
-- ============================================================

-- 一、點名：哪幾組（人×角色）手上還有超過一天的明細。
--    order by random()：某一組若一直收不成（模型失敗就不刪），不會每天佔同一格、把別人餓死。
create or replace function chat_expired_pairs(p_limit int default 20)
returns table (user_id uuid, character_id text)
language sql volatile security definer set search_path = public as $$
  select m.user_id, m.character_id
  from chat_messages m
  where m.created_at < now() - interval '1 day'
  group by m.user_id, m.character_id
  order by random()
  limit greatest(1, least(coalesce(p_limit, 20), 200));
$$;

-- 二、每組一把短鎖：聊天回覆後、打開閒聊時、每日清理，三條路可能同時收同一組 → 重複回憶、重複花費。
--    搶到才收；五分鐘沒放就當上一次掛了，讓下一次接手。沒有 user_character 列的不鎖（照收）。
alter table user_character add column if not exists condense_lock_at timestamptz;

create or replace function condense_claim(p_user uuid, p_char text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v_n int;
begin
  update user_character set condense_lock_at = now()
   where user_id = p_user and character_id = p_char
     and (condense_lock_at is null or condense_lock_at < now() - interval '5 minutes');
  get diagnostics v_n = row_count;
  if v_n > 0 then return true; end if;
  return not exists (select 1 from user_character where user_id = p_user and character_id = p_char);
end $$;

create or replace function condense_release(p_user uuid, p_char text)
returns void
language sql volatile security definer set search_path = public as $$
  update user_character set condense_lock_at = null where user_id = p_user and character_id = p_char;
$$;

revoke all on function chat_expired_pairs(int) from public, anon, authenticated;
revoke all on function condense_claim(uuid, text) from public, anon, authenticated;
revoke all on function condense_release(uuid, text) from public, anon, authenticated;
grant execute on function chat_expired_pairs(int) to service_role;
grant execute on function condense_claim(uuid, text) to service_role;
grant execute on function condense_release(uuid, text) to service_role;

-- 驗收：select * from chat_expired_pairs(5);

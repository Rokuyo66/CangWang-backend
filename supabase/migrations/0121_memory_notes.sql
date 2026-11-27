-- 0121 短期筆記與每月升格（六六 2026-11-27）
--
-- 病灶：每次閒聊結束就直接寫成「回憶」，寫一堆待辦、一時的累，回憶頁滿是雜訊；
-- 而且回憶整包塞進每句對話，角色像卡到陰一樣一直自己提起來。
--
-- 改法：
--   ・每天整理只寫進 memory_notes（短期筆記，不顯示在回憶頁）
--   ・聊天時只有他這句話對得上的筆記／回憶才「被喚醒」帶進去；被喚醒那次角色回了多少 token，記在那則筆記上
--   ・每月他登入時看一次：累積 token 夠多（真的被認真聊過）的筆記才升格成 character_memories；
--     沒升格、放超過 30 天的筆記就淡掉
--
-- 只由 edge function（service role）讀寫：開 RLS、不給任何 client policy。

create table if not exists public.memory_notes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  character_id  text not null,
  body          text not null,
  kind          text check (kind in ('trait', 'event', 'state')),
  happened_on   date,
  wake_tokens   integer not null default 0,
  wake_count    integer not null default 0,
  last_woken_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists memory_notes_owner_idx on public.memory_notes (user_id, character_id, created_at desc);
alter table public.memory_notes enable row level security;

-- 每月升格的時間戳（null＝還沒開始算，第一次只立基準不升格）
alter table public.user_character add column if not exists memory_review_at timestamptz;

-- 被喚醒：原子加總，免得兩句話同時回來時互蓋
create or replace function public.wake_memory_notes(p_ids uuid[], p_tokens integer)
returns void language sql security definer set search_path = public as $$
  update public.memory_notes
     set wake_tokens = wake_tokens + greatest(p_tokens, 0),
         wake_count = wake_count + 1,
         last_woken_at = now()
   where id = any(p_ids);
$$;

-- 每月一次的門：搶到才升格（兩個分頁同時打開閒聊，只有一個會跑）
-- 回傳 'first'＝第一次（只立基準）、'due'＝到期且已搶下、null＝還沒到或被搶走
create or replace function public.claim_memory_review(p_user uuid, p_char text, p_days integer default 30)
returns text language plpgsql security definer set search_path = public as $$
declare prev timestamptz; hit int;
begin
  select memory_review_at into prev from public.user_character where user_id = p_user and character_id = p_char;
  if not found then return null; end if;
  if prev is null then
    update public.user_character set memory_review_at = now()
     where user_id = p_user and character_id = p_char and memory_review_at is null;
    get diagnostics hit = row_count;
    return case when hit > 0 then 'first' else null end;
  end if;
  update public.user_character set memory_review_at = now()
   where user_id = p_user and character_id = p_char
     and memory_review_at = prev and prev < now() - make_interval(days => p_days);
  get diagnostics hit = row_count;
  return case when hit > 0 then 'due' else null end;
end $$;

revoke all on function public.wake_memory_notes(uuid[], integer) from public, anon, authenticated;
revoke all on function public.claim_memory_review(uuid, text, integer) from public, anon, authenticated;

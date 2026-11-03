-- 0113_atomic_quota.sql — 免費額度與每分鐘限流改成原子操作
--
-- 【為什麼】
-- 原本每一處都是「先 select used_today → 在程式裡判斷 → 再 upsert used+1」。
-- 兩個請求同時讀到同一個 used，就都判成「還有額度」。聊天那一支最嚴重：
-- 讀在呼叫模型之前、寫在模型回完之後，中間隔著整段模型延遲（好幾秒），
-- 同時送二十句，二十句都是「今天第一句」。rate_minute 也是同一個寫法，
-- 所以每分鐘 6 次的限流擋不住同一瞬間的並發。
--
-- 【做法】
-- 判斷與加一放進同一條 insert … on conflict do update … where：
-- 資料列鎖保證同一把 key 一次只有一個請求能加，where 不成立就不更新、returning 為空。
--
-- 權限：0044 的全域 default privileges 已讓新 function 只給 service_role，
-- 這裡再明寫一次，不靠「記得有那條」。

-- 佔一格免費額度。成功回佔用後的次數；額度已滿回 null。
-- 隔日（last_reset 不是今天）視同歸零，從 1 開始。
create or replace function consume_free_quota(p_key text, p_limit int, p_day date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v int;
begin
  if p_limit is null or p_limit <= 0 then
    return null;
  end if;
  insert into free_quota as f (key, used_today, last_reset)
  values (p_key, 1, p_day)
  on conflict (key) do update
    set used_today = case when f.last_reset = p_day then f.used_today + 1 else 1 end,
        last_reset = p_day
    where f.last_reset is distinct from p_day or f.used_today < p_limit
  returning used_today into v;
  return v;
end $$;

-- 退回一格（佔了額度卻沒產出回覆、或那一則判成免費的探詢輪）。
-- 只退當天的，不退成負數。
create or replace function refund_free_quota(p_key text, p_day date)
returns void
language sql
security definer
set search_path = public
as $$
  update free_quota set used_today = used_today - 1
   where key = p_key and last_reset = p_day and used_today > 0;
$$;

-- 每分鐘限流：計數加一並回傳加完的值。呼叫端拿到 > 上限就擋。
create or replace function bump_rate_minute(p_user uuid, p_minute text)
returns int
language sql
security definer
set search_path = public
as $$
  insert into rate_minute as r (user_id, minute, count)
  values (p_user, p_minute, 1)
  on conflict (user_id, minute) do update set count = r.count + 1
  returning count;
$$;

revoke execute on function consume_free_quota(text, int, date) from public, anon, authenticated;
revoke execute on function refund_free_quota(text, date)       from public, anon, authenticated;
revoke execute on function bump_rate_minute(uuid, text)         from public, anon, authenticated;
grant  execute on function consume_free_quota(text, int, date) to service_role;
grant  execute on function refund_free_quota(text, date)       to service_role;
grant  execute on function bump_rate_minute(uuid, text)         to service_role;

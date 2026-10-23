-- 0101_lockdown_public_tables.sql — 資料庫全鎖，不再靠每支 migration 自己記得寫（2026-10-22 上線檢查 P0）
--
-- 安全模型沒變（0001 檔尾）：RLS 全開、零 policy、所有存取都經 Edge Function 的 service role。
-- 前端一律打 interpret，不直接碰任何表（2026-10-22 前端 src 全文確認：沒有 sb.from／rpc／channel）。
--
-- 0055 補了六張漏鎖的表，但那仍是「列一張補一張」——之後線上直接跑的 mailbot（0091～0094 另一條分支）、
-- 或哪一天某支 migration 又忘了寫，就又是一個任何人拿前端那把 anon key 都能讀寫的表。
-- 這一支改成三道「不管表叫什麼都成立」的鎖：
--
--   一、public 底下每一張沒開 RLS 的表，現在就開（開了就是 anon／authenticated 一律拒絕）
--   二、收回 anon／authenticated 對 public 所有表、序列的權限（RLS 之外的第二道）
--   三、之後新建的表、序列，預設就不給 anon／authenticated（Supabase 預設會自動 grant ALL）
--
-- service_role 不受影響（它本來就繞過 RLS，權限也不在這裡收）。Edge Function 照常運作。
-- 跑完看最後那張清單：應該是空的；不是空的就是有表還沒鎖。

do $$
declare r record; n int := 0;
begin
  for r in
    select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    raise notice '補上 RLS：%', r.relname;
    n := n + 1;
  end loop;
  raise notice '共補 % 張', n;
end $$;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
-- Supabase 上建表的不一定是執行這支的角色（儀表板、CLI 有時是 postgres 或 supabase_admin）：各補一次，沒權限就略過
do $$
declare r text;
begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    begin
      execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated', r);
      execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated', r);
    exception when others then raise notice '略過 %（%）', r, sqlerrm;
    end;
  end loop;
end $$;

-- 驗收：沒開 RLS 的表（應為空）
select c.relname as "還沒開 RLS 的表"
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

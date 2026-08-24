-- 0044_lock_rpc_fix.sql — 0036 的「往後新增的 function 自動是鎖的」其實沒有生效
--
-- 0036 用這兩行收未來的權：
--
--   alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
--   alter default privileges in schema public grant  execute on functions to service_role;
--
-- 第二行有效，第一行是無聲的 no-op。**帶 `in schema` 的 default privileges 是「疊加」
-- 到全域預設之上，不是取代它**，所以一個 schema 範圍的 revoke 永遠拿不掉內建預設
-- 給 PUBLIC 的那份 EXECUTE。實測（PostgreSQL 16）：
--
--   alter default privileges in schema public revoke all on functions from PUBLIC;
--     → pg_default_acl 連一列都不會寫進去，之後 create 的 function ACL 仍是
--       {=X/postgres, postgres=X/postgres}
--   alter default privileges              revoke all on functions from PUBLIC;   -- 不帶 in schema
--     → 寫得進去，之後 create 的 function ACL 是 {postgres=X/postgres}
--
-- 後果：0036 之後新增的每一支 function 都還開著 /rest/v1/rpc/<name>，
-- 而那把 anon key 是公開的。0036 檔頭描述的洞，對「後來才長出來的 function」
-- 從來沒有被補上——而且不會有任何徵兆，功能一切正常。
--
-- 目前受影響的只有 0039 的 case_runs_touch（trigger function，直接呼叫做不了什麼），
-- 以及 0043 的 price_of／ai_cost（0043 已自行明確收權）。損害有限純屬運氣好：
-- 下一支 security definer function 就不一定了。

-- 一、把現存的全部重收一次（同 0036 首段，冪等）
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;

-- 二、真正管住未來的兩行：拿掉 `in schema public`。
--     全域預設沒有 schema 限定，才蓋得掉內建預設。
alter default privileges revoke execute on functions from public, anon, authenticated;
alter default privileges grant  execute on functions to service_role;

-- 三、0036 那兩行留著無害（grant 那句仍有用），不必回收。
--     真正的驗收不是看這支跑過沒有，是跑下面這一句——它應該回 0 列：
--
--       select p.proname
--       from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and (p.proacl is null
--              or exists (select 1 from aclexplode(p.proacl) a
--                         where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
--
--     proacl is null 代表「吃內建預設」＝ PUBLIC 可執行；aclexplode 的 grantee = 0
--     就是 PUBLIC。兩者都是洞。新增 function 之後值得順手跑一次。
--
--     別用字串比對 proacl::text like '%=X/%' 找 PUBLIC——正常的
--     {postgres=X/postgres,service_role=X/postgres} 也含 '=X/'，那樣會把每一支
--     鎖好的 function 都報成洞，然後你就會開始忽略這份報告。

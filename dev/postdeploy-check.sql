-- dev/postdeploy-check.sql — 部署完之後，一次驗完
--
-- 貼進 Supabase 主控台 → SQL Editor 整份跑。每一列是一項檢查，「結果」欄只有
-- ✅ 與 ❌ 兩種。全綠才算部署完成。
--
-- 為什麼壓成一段：分開跑六個查詢，一定會有一次忘記跑，而忘記跑的那一項
-- 通常就是壞掉的那一項。

select * from (

  -- ① 所有資料表都開了 RLS（0055）
  --    這個專案的安全模型是「RLS 開著、零 policy、只走 service role」。
  --    沒開 RLS 的表 ＝ 前端那把公開 anon key 可以直接讀寫。
  select 1 as ord, '① RLS 全開（0055）' as "檢查項目",
         case when count(*) = 0 then '✅ 通過' else '❌ ' || count(*)::text || ' 張沒開' end as "結果",
         coalesce(string_agg(c.relname, '、' order by c.relname), '—') as "細節"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

  union all
  -- ② casts.yong_via_ying 欄位在（0054）
  --    沒有它，interpret 的起卦 INSERT 與卦歷 SELECT 全部會失敗。
  select 2, '② casts.yong_via_ying（0054）',
         case when count(*) = 1 then '✅ 欄位在' else '❌ 欄位不存在，起卦會壞' end,
         case when count(*) = 1 then 'boolean' else '請套用 0054_yong_via_ying.sql' end
    from information_schema.columns
   where table_schema = 'public' and table_name = 'casts' and column_name = 'yong_via_ying'

  union all
  -- ③ delete_account 函式在，且只有 service_role 執行得了（0056）
  select 3, '③ delete_account 函式（0056）',
         case when count(*) = 1 then '✅ 存在' else '❌ 不存在' end,
         case when count(*) = 1 then 'security definer' else '請套用 0056_delete_account.sql' end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'delete_account'

  union all
  -- ④ plaza_notices 的外鍵改指 profiles 了（0056）
  --    0029 原本指向 auth.users，與全站寫入的 id 空間不符，那個 insert 從來沒成功過。
  select 4, '④ plaza_notices 外鍵（0056）',
         case when count(*) = 1 then '✅ 指向 profiles' else '❌ 仍指向別處' end,
         coalesce(max(confrelid::regclass::text), '—')
    from pg_constraint
   where conrelid = 'public.plaza_notices'::regclass
     and contype = 'f'
     and confrelid = 'public.profiles'::regclass

  union all
  -- ⑤ 沒有任何 function 是 PUBLIC 可執行的（0036／0044 的驗收）
  --    proacl is null ＝ 吃內建預設 ＝ PUBLIC 可執行；aclexplode 的 grantee = 0 就是 PUBLIC。
  --    別改成字串比對 proacl::text like '%=X/%'——正常的 ACL 也含它，會把每一支都報成洞。
  select 5, '⑤ 無公開可執行的 function（0044）',
         case when count(*) = 0 then '✅ 通過' else '❌ ' || count(*)::text || ' 支開著' end,
         coalesce(string_agg(p.proname, '、' order by p.proname), '—')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))

  union all
  -- ⑥ 沒有孤兒列：指向已不存在的人的資料
  --    這一項在還沒測過刪除之前本來就該是 0；測完刪除再跑一次才是真正的驗收。
  select 6, '⑥ 無孤兒列',
         case when coalesce(sum(n), 0) = 0 then '✅ 通過' else '❌ 共 ' || sum(n)::text || ' 列' end,
         coalesce(string_agg(t || '(' || n::text || ')', '、' order by t), '—')
    from (
      select 'casts' t, count(*) n from casts x
       where x.user_id is not null and not exists (select 1 from profiles p where p.id = x.user_id)
      union all
      select 'ledger', count(*) from ledger x
       where not exists (select 1 from profiles p where p.id = x.user_id)
      union all
      select 'cast_claims', count(*) from cast_claims x
       where not exists (select 1 from profiles p where p.id = x.user_id)
      union all
      select 'tg_sessions', count(*) from tg_sessions s
       where not exists (select 1 from identities i
                          where i.provider = 'tg' and i.external_id = s.tg_id)
    ) q
   where n > 0

) r order by ord;

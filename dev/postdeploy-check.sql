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

  union all
  -- ⑦ 訂閱與價目這幾張表真的到位了（0058／0059）
  --    少任何一張，程式端不會當掉——它會沿用寫死的預設價，然後你在資料庫裡
  --    改價改了半天沒有反應，而那種「改了沒效」最難查。
  select 7, '⑦ 訂閱與價目的表（0058／0059）',
         case when count(*) = 4 then '✅ 四張都在' else '❌ 缺 ' || (4 - count(*))::text || ' 張' end,
         coalesce(string_agg(tablename, '、' order by tablename), '—')
    from pg_tables
   where schemaname = 'public'
     and tablename in ('plans', 'orders', 'order_payments', 'lingshi_prices')

  union all
  -- ⑧ 價目表的值與程式端的預設一致
  --    兩邊本來就該一樣（dev/pricing-test.mts 在 CI 那一側釘著），這裡驗的是
  --    「線上這一份有沒有被套用」——migration 漏套的話，程式沿用預設，
  --    看起來一切正常，直到有人 update 了價卻發現沒動靜。
  select 8, '⑧ 靈石價目已套用（0059）',
         case when count(*) >= 7 then '✅ ' || count(*)::text || ' 項' 
              else '❌ 只有 ' || count(*)::text || ' 項，應為 7' end,
         coalesce(string_agg(action || '=' || cost::text, '、' order by action), '—')
    from lingshi_prices

  union all
  -- ⑨ 最高階的免費朗讀次數（0059）
  --    這一欄沒套用的話預設是 0，於是藏往的使用者每念一次都被扣 66 顆靈石，
  --    而方案頁上寫著「每月免費朗讀 8 次」——那是最快收到客訴的一種不一致。
  select 9, '⑨ 藏往的免費朗讀次數（0059）',
         case when coalesce(max(tts_free_readings), 0) > 0
              then '✅ ' || max(tts_free_readings)::text || ' 次／月'
              else '❌ 是 0——方案頁寫的與實際扣的會對不上' end,
         coalesce(max(tts_free_readings)::text, '—')
    from plans where id = 'cangwang'

) r order by ord;

-- dev/orphan-check.sql — 刪完帳號之後，掃一遍還有沒有東西留著
--
-- 帳號刪除唯一可信的驗收方式，不是看那支 function 有沒有報錯，是刪完之後掃一遍
-- 資料庫，看還有沒有指向「已經不存在的人」的列。0056 的 delete_account 涵蓋的表
-- 是照當時的 schema 列的——往後每加一張帶 user_id 的表，那份清單就少一張，
-- 而少掉不會報錯，只會安靜地留下一堆孤兒。
--
-- 怎麼用：在 Supabase 主控台 → SQL Editor 貼上整份跑。
--   ・第一段（零維護）應該回 0 列。回了東西＝那張表沒被 delete_account 涵蓋到。
--   ・第二、三段是兩張特例表，關聯方式不是 user_id，掃不到，得分開查。
--
-- 建議時機：每次跑完一次真實的刪除測試之後；以及往後新增資料表時順手跑一次。

-- ── 一、所有帶 user_id 欄位的表：指向已不存在的 profiles 的列
--
-- 零維護：直接讀 information_schema，新表自動納入，不必回來補清單。
-- ai_usage 排除在外——0056 刻意把它的 user_id 設為 null 而不刪（成本核算要用），
-- 而 null 本來就不算孤兒，所以 where 的 not null 條件已經把它濾掉了。
do $$
declare
  r record;
  n bigint;
begin
  create temp table if not exists orphan_report(tbl text, orphans bigint) on commit drop;
  delete from orphan_report;
  for r in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'user_id'
       and c.data_type = 'uuid'
       and t.table_type = 'BASE TABLE'
     order by c.table_name
  loop
    execute format(
      'select count(*) from %I x where x.user_id is not null
         and not exists (select 1 from profiles p where p.id = x.user_id)', r.table_name)
      into n;
    if n > 0 then
      insert into orphan_report values (r.table_name, n);
    end if;
  end loop;
end $$;

select tbl as "表", orphans as "孤兒列數" from orphan_report order by orphans desc;

-- ── 二、free_quota：主鍵是拼出來的字串，沒有 user_id 欄位
--
-- 鍵有三種形狀：<uid>（網頁起卦額度）、<前綴>:<uid>:<日期>、tg:<tg_id>。
-- 這裡只查得出前兩種（第三種要對 identities，見第三段）。
select f.key as "殘留的額度鍵"
  from free_quota f
 where (
        -- 形狀一：整個 key 就是一個 uuid
        (f.key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and not exists (select 1 from profiles p where p.id::text = f.key))
        or
        -- 形狀二：<前綴>:<uuid>:<日期>
        (split_part(f.key, ':', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and not exists (select 1 from profiles p where p.id::text = split_part(f.key, ':', 2)))
       )
 limit 50;

-- ── 三、tg_sessions：主鍵是 tg_id，與 profiles 之間沒有任何外鍵
--
-- 一列 tg_session 對得回一個人，靠的是 identities。identities 是 cascade 的，
-- 所以帳號一刪，這裡的對照就斷了——delete_account 必須在刪 profiles 之前
-- 先把 tg_id 抓出來，抓漏了就會在這一段現形。
select s.tg_id as "殘留的 TG 對話", s.updated_at as "最後更新"
  from tg_sessions s
 where not exists (
   select 1 from identities i
    where i.provider = 'tg' and i.external_id = s.tg_id)
 order by s.updated_at desc
 limit 50;

-- ── 附：tts bucket 不在檢查範圍內
--
-- voice_clips 只是指標。音檔放在全站共用的 tts bucket，檔名是「模型＋聲線＋
-- 逐字文本」的 SHA-256，同一段話所有人共用同一個檔。刪帳號不刪檔是對的——
-- 刪了會把別人的收藏一起弄啞，而那個檔本身不含任何可指向個人的資訊。

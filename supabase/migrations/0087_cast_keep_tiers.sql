-- 0087_cast_keep_tiers.sql — 卦的保存期限照玉牒分階；日運只留七天；卦的搜尋
--
-- 0009／0079 的週清理：90 天前、沒有印證、不在心跡裡的卦，一律刪。這條對無牒與藏往
-- 一視同仁——牒買不到「卦不被清」，而「藏往」這個名字本來就是在賣這件事。
-- （六六 2026-10-16：搜尋舊卦要提醒多久會被刪，並引導持牒擴充；日運卦不保存。）
--
-- 【新規則】
--
--   保存期限（從起卦那天算）：
--     無牒 90 天｜觀微 180｜知幾 365｜藏往 永久
--   數字是資料：放在 plans.keep_days（null＝永久），調整＝update 一列。
--   無牒不在 plans 表裡，90 天寫在 cast_keep_days()。
--
--   不論方案，以下任一成立就永久保留（0079 原樣）：
--     ① 有印證結果（feedback.verdict 1/2/3）
--     ② 歸在某件心事裡（casts.thread_id）
--     ③ 被心事的留言引用（thread_notes.cast_id）
--
--   日運卦：一律只留 7 天，上面三條保護與方案都不適用。
--   它是每日免費贈的今日氣象，不入卦鑑、不能追問、歸不進心事，也不進搜尋；
--   留著只是每人每年 365 列沒人回頭看的資料。
--
-- 【斷牒的緩衝：30 天】
--
-- 牒到期那一刻若立刻改回 90 天，藏往一年的卦會在下一次清理時一口氣全沒——
-- 那是把付過錢買的東西收回去，而且是在他最可能回來續牒的那幾天。
-- 所以 plan_until 過後 30 天內，保存期限仍照原方案算；過了緩衝才回到無牒的 90 天。
-- profiles.plan 在到期後不會被清掉（planOf 只看 plan_until），所以原方案查得到。
-- 前端要在緩衝期內提醒「X 日前續牒，舊卦照原規格保留」，見 dev/web/CAST-SEARCH-API.md。
--
-- 【清理改成每天跑】
--
-- 週跑的話，日運最晚要到第 14 天才清、畫面上「剩 N 天」也會差到一週。
-- 每天跑的成本是每天一次 delete：過期列每天只會多出一天份，掃 casts(created_at) 一次而已。

-- ── 一、方案的保存天數
alter table plans add column if not exists keep_days int;
comment on column plans.keep_days is
  '卦的保存天數（從起卦算）。null＝永久。無牒不在此表，固定 90（cast_keep_days）。';

update plans set keep_days = 180  where id = 'guanwei';
update plans set keep_days = 365  where id = 'zhiji';
update plans set keep_days = null where id = 'cangwang';

-- blurb 只在還是原句時才改：線上若已手動調過，就不蓋掉
update plans set blurb = '每日五卦五追問，心事同時記八件，卦留一年'
 where id = 'zhiji' and blurb = '每日五卦五追問，心事同時記八件';   -- 0067 的字
update plans set blurb = '每日八卦二十追問，每月八次角色朗讀，卦永久收藏'
 where id = 'cangwang' and blurb = '每日八卦二十追問，每月八次角色朗讀';

create index if not exists casts_created on casts (created_at);

-- ── 二、某人此刻的保存天數（null＝永久）
-- 方案判斷與 planOf 一致：plan 為空或 free → 無牒；plan_until 為空 → 視為有效（手動撥的牒）。
-- 差別只在緩衝：plan_until 過後 30 天內仍算原方案。
create or replace function cast_keep_days(p_plan text, p_plan_until timestamptz)
returns int
language plpgsql
stable
as $$
declare
  r plans%rowtype;
begin
  if p_plan is null or p_plan = 'free' then return 90; end if;
  if p_plan_until is not null and p_plan_until < now() - interval '30 days' then return 90; end if;
  select * into r from plans where id = p_plan;
  if not found then return 90; end if;
  return r.keep_days;
end;
$$;

-- 給 edge function 用：一次拿到天數與緩衝期截止（不在緩衝期就是 null）
create or replace function cast_keep_of(p_user uuid)
returns table (keep_days int, grace_until timestamptz)
language sql
stable
security definer
as $$
  select cast_keep_days(p.plan, p.plan_until),
         case when p.plan is not null and p.plan <> 'free'
               and p.plan_until is not null
               and p.plan_until < now()
               and p.plan_until >= now() - interval '30 days'
              then p.plan_until + interval '30 days' end
    from profiles p where p.id = p_user;
$$;

-- ── 三、一張卦是否受永久保護（印證／心事／被留言引用）
-- 清理與搜尋共用這一支，「畫面寫永久」與「清理不刪」才不會各說各話。
create or replace function cast_is_kept(p_cast uuid, p_thread uuid)
returns boolean
language sql
stable
as $$
  select p_thread is not null
      or exists (select 1 from feedback f where f.cast_id = p_cast and f.verdict in (1, 2, 3))
      or exists (select 1 from thread_notes tn where tn.cast_id = p_cast);
$$;

-- ── 四、清理
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
     using (
       select c2.id
         from casts c2
         left join profiles p on p.id = c2.user_id
        where c2.created_at < now() - interval '7 days'
          and (
            c2.category = '日運'
            or (
              coalesce(c2.category, '') <> '日運'
              and cast_keep_days(p.plan, p.plan_until) is not null
              and c2.created_at < now() - make_interval(days => cast_keep_days(p.plan, p.plan_until))
              and not cast_is_kept(c2.id, c2.thread_id)
            )
          )
     ) x
     where c.id = x.id
    returning 1
  )
  select count(*) into n from del;
  return n;
end;
$$;

-- 週排程換成日排程（03:00 UTC＝台灣 11:00）。舊 job 不在時 unschedule 會報錯，吞掉。
do $$
begin
  perform cron.unschedule('cleanup-expired-casts-weekly');
exception when others then null;
end $$;

select cron.schedule(
  'cleanup-expired-casts-daily',
  '0 3 * * *',
  $$select cleanup_expired_casts();$$
);

-- ── 五、搜尋
-- 比對：問句、摘要、追問的問句（ilike），本卦／變卦（卦名包含）。
-- 多個關鍵字以空白分隔，全部都要中（AND）。日運不進搜尋。
-- 分頁：p_before 給上一頁最後一筆的 created_at，新→舊。
-- expires_at：這一卦預計被清的時點；永久保存（受保護或方案永久）為 null。
--   實際刪除在那之後的第一次清理（每天 03:00 UTC），畫面寫「剩 N 天」不會多報。
--   斷牒緩衝期內不能照原方案報：藏往的緩衝期裡標「永久」，緩衝一過照樣被清，是騙人。
--   緩衝期內的保存天數是 K（原方案），之後是 90，所以預計被清的時點是：
--     起卦＋K 早於緩衝截止 → 起卦＋K（緩衝期內就到期）
--     否則                  → max(緩衝截止, 起卦＋90)
create or replace function search_casts(
  p_user uuid, p_q text, p_before timestamptz default null, p_limit int default 30
)
returns table (
  id uuid, question text, digest text, gua_ben text, gua_bian text,
  category text, character_id text, created_at timestamptz, due_date date,
  thread_id uuid, verdict smallint, kept boolean, expires_at timestamptz
)
language plpgsql
stable
security definer
as $$
declare
  terms text[];
  keep  int;
  grace timestamptz;
begin
  -- 跳脫 LIKE 的萬用字元：問「100%」不該變成「100 後面接任何東西」
  select array_agg('%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%')
    into terms
    from unnest(regexp_split_to_array(btrim(coalesce(p_q, '')), '\s+')) t
   where t <> '';
  if terms is null then return; end if;

  select k.keep_days, k.grace_until into keep, grace from cast_keep_of(p_user) k;
  if not found then keep := 90; end if;

  return query
  select c.id, c.question, c.digest, c.gua_ben, c.gua_bian,
         c.category, c.character_id, c.created_at, c.due_date,
         c.thread_id, f.verdict,
         x.exp is null as kept,
         x.exp as expires_at
    from casts c
    left join feedback f on f.cast_id = c.id
    cross join lateral (
      select case
        when cast_is_kept(c.id, c.thread_id) then null
        when grace is null then
          case when keep is null then null else c.created_at + make_interval(days => keep) end
        when keep is not null and c.created_at + make_interval(days => keep) < grace
          then c.created_at + make_interval(days => keep)
        else greatest(grace, c.created_at + interval '90 days')
      end as exp
    ) x
   where c.user_id = p_user
     and coalesce(c.category, '') <> '日運'
     and (p_before is null or c.created_at < p_before)
     -- 「沒有哪個關鍵字落空」＝全部都中。coalesce 不能省：digest／gua_bian 常是 null，
     -- 一個 null 會讓 not(...) 變 null、被 where 濾掉，結果是每一卦都算「全中」。
     and not exists (
       select 1 from unnest(terms) t
        where not coalesce(
          c.question ilike t or c.digest ilike t
          or c.gua_ben ilike t or c.gua_bian ilike t
          or exists (select 1 from followups fu where fu.cast_id = c.id and fu.question ilike t),
          false)
     )
   order by c.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 50);
end;
$$;

-- 權限：全部只給 service role（同 0036 的收法），用戶端不能直接打
revoke execute on function cast_keep_days(text, timestamptz)   from public, anon, authenticated;
revoke execute on function cast_keep_of(uuid)                   from public, anon, authenticated;
revoke execute on function cast_is_kept(uuid, uuid)             from public, anon, authenticated;
revoke execute on function cleanup_expired_casts()              from public, anon, authenticated;
revoke execute on function search_casts(uuid, text, timestamptz, int) from public, anon, authenticated;
grant  execute on function cast_keep_days(text, timestamptz)   to service_role;
grant  execute on function cast_keep_of(uuid)                   to service_role;
grant  execute on function cast_is_kept(uuid, uuid)             to service_role;
grant  execute on function cleanup_expired_casts()              to service_role;
grant  execute on function search_casts(uuid, text, timestamptz, int) to service_role;

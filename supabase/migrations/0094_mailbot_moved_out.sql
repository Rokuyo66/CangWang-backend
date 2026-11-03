-- 0094_mailbot_moved_out.sql — 信箱管家搬到獨立的 Supabase 專案，產品資料庫裡不留觀主的信
--
-- 2026-10-19：管家原本寄住在產品專案（0091～0093）。觀主的信件寄件人、主旨、摘要不該躺在產品資料庫裡——
-- 日後開協作者、匯出備份給別人，這些都會一起出去。管家搬到 mailbot/（自己的專案、自己的 migration），
-- 這裡收尾兩件事：
--   一、admin_weekly_stats() 拿掉 mail 那一段（它讀的是下面要刪的表），其餘不變
--   二、刪掉 mailbot_* 三張表
--
-- ⚠ 刪表違反「migration 只加不刪」的慣例，是刻意的：這不是產品的資料、沒有回滾的需要，
--   留著才是風險。觀主在 TG 按出來的規則若要帶過去，先跑 mailbot/README.md「搬家」那一段再上這支。

create or replace function admin_weekly_stats(p_end date default ((now() at time zone 'Asia/Taipei')::date - 1))
returns jsonb
language sql
security definer
as $$
  with b as (
    select
      ((p_end - 6)::timestamp  at time zone 'Asia/Taipei') as cur_from,
      ((p_end + 1)::timestamp  at time zone 'Asia/Taipei') as cur_to,
      ((p_end - 13)::timestamp at time zone 'Asia/Taipei') as prv_from
  ),
  act as (   -- 活躍＝這段時間有起卦或說過話
    select user_id, created_at from casts where user_id is not null
    union all
    select user_id, created_at from chat_messages where role = 'user'
  ),
  wk as (
    select 'cur' w, b.cur_from f, b.cur_to t from b
    union all
    select 'prv', b.prv_from, b.cur_from from b
  ),
  m as (
    select wk.w, jsonb_build_object(
      'new_users',   (select count(*) from profiles where created_at >= wk.f and created_at < wk.t),
      'active_users',(select count(distinct user_id) from act where created_at >= wk.f and created_at < wk.t),
      'casts',       (select count(*) from casts where created_at >= wk.f and created_at < wk.t),
      'casts_web',   (select count(*) from casts where channel <> 'tg' and created_at >= wk.f and created_at < wk.t),
      'followups',   (select count(*) from followups where created_at >= wk.f and created_at < wk.t),
      'chats',       (select count(*) from chat_messages where role = 'user' and created_at >= wk.f and created_at < wk.t),
      'verdicts',    (select count(*) from feedback where verdict in (1,2,3) and answered_at >= wk.f and answered_at < wk.t),
      'verdict_hit', (select count(*) from feedback where verdict = 1 and answered_at >= wk.f and answered_at < wk.t),
      'lingshi_spent',(select coalesce(-sum(amount), 0) from ledger where amount < 0 and created_at >= wk.f and created_at < wk.t),
      'revenue_twd', (select coalesce(sum(amount), 0) from order_payments where paid_at >= wk.f and paid_at < wk.t),
      'payments',    (select count(*) from order_payments where paid_at >= wk.f and paid_at < wk.t),
      'ai_twd',      (select coalesce(round(sum(usd) * 32, 0), 0) from ai_usage_cost where created_at >= wk.f and created_at < wk.t)
    ) j
    from wk
  )
  select jsonb_build_object(
    'from', (p_end - 6)::text,
    'to',   p_end::text,
    'cur',  (select j from m where w = 'cur'),
    'prv',  (select j from m where w = 'prv'),
    -- 留存：上週活躍的人，這週還有回來的比例
    'retained', (select count(distinct a.user_id) from act a, b
                  where a.created_at >= b.cur_from and a.created_at < b.cur_to
                    and a.user_id in (select user_id from act, b b2
                                       where act.created_at >= b2.prv_from and act.created_at < b2.cur_from)),
    'casts_by_char', (select coalesce(jsonb_object_agg(character_id, c), '{}'::jsonb) from (
        select coalesce(character_id, '?') character_id, count(*) c from casts, b
         where created_at >= b.cur_from and created_at < b.cur_to group by 1) x),
    'casts_by_cat',  (select coalesce(jsonb_object_agg(cat, c), '{}'::jsonb) from (
        select coalesce(category, '其他') cat, count(*) c from casts, b
         where created_at >= b.cur_from and created_at < b.cur_to group by 1 order by 2 desc limit 6) x),
    'by_day', (select coalesce(jsonb_object_agg(d, n), '{}'::jsonb) from (
        select (created_at at time zone 'Asia/Taipei')::date::text d, count(distinct user_id) n
          from act, b where created_at >= b.cur_from and created_at < b.cur_to group by 1) x)
  );
$$;
revoke all on function admin_weekly_stats(date) from public, anon, authenticated;

drop table if exists mailbot_seen;
drop table if exists mailbot_rules;
drop table if exists mailbot_labels;

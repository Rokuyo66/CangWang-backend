-- 0091_mail_butler.sql — 觀主的信箱管家 ＋ 週報
--
-- 一、mailbot_rules：觀主在 TG 按出來的規則（寄件人／網域／主旨關鍵字 → 刪／報／留）
-- 二、mailbot_seen ：每封看過的信一列。判重（同一封不處理兩次）、待問清單、週報的「刪了幾封」都從這裡來
-- 三、admin_weekly_stats()：產品週報的數字，本週 vs 上週，台北日界
--
-- 兩張表都只給 service_role（RLS 開著、不給 policy）：信箱內容是觀主私人的，不該有任何前端路徑讀得到。
-- 全部冪等：可重跑。

create table if not exists mailbot_rules (
  id          bigserial primary key,
  kind        text not null check (kind in ('sender','domain','subject')),
  pattern     text not null,                 -- 一律存小寫；subject 為「包含」比對
  action      text not null check (action in ('trash','report','keep')),
  note        text,
  hits        int  not null default 0,
  last_hit_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (kind, pattern)
);
comment on table mailbot_rules is
  '信箱管家規則。優先序：sender > domain > subject；同層 report／keep 勝過 trash（寧可多留一封，不可錯刪一封）。';

create table if not exists mailbot_seen (
  id          bigserial primary key,
  gmail_id    text not null unique,
  thread_id   text,
  sender      text,                          -- 小寫 email
  sender_name text,
  subject     text,
  snippet     text,
  received_at timestamptz,
  decision    text not null check (decision in ('trash','report','keep','ask')),
  source      text not null check (source in ('rule','ai','user','guard')),
  reason      text,
  status      text not null default 'done' check (status in ('done','open')),  -- open = 等觀主回答
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists mailbot_seen_open_idx on mailbot_seen (created_at) where status = 'open';
create index if not exists mailbot_seen_created_idx on mailbot_seen (created_at);

alter table mailbot_rules enable row level security;
alter table mailbot_seen  enable row level security;

-- ── 週報 ─────────────────────────────────────────────────────
-- 一週＝p_end 往回 7 個台北日（含 p_end）。預設 p_end＝昨天：週一早上發，報的是上週一到週日整週。
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
          from act, b where created_at >= b.cur_from and created_at < b.cur_to group by 1) x),
    'mail', jsonb_build_object(
      'trashed',  (select count(*) from mailbot_seen, b where decision = 'trash'  and created_at >= b.cur_from and created_at < b.cur_to),
      'reported', (select count(*) from mailbot_seen, b where decision = 'report' and created_at >= b.cur_from and created_at < b.cur_to),
      'open',     (select count(*) from mailbot_seen where status = 'open'),
      'rules',    (select count(*) from mailbot_rules))
  );
$$;
revoke all on function admin_weekly_stats(date) from public, anon, authenticated;

-- 排程（pg_cron → mail-butler）不寫在這裡：要帶 internal secret，不能進版控。
-- 設法見 dev/MAIL-BUTLER.md「第 4 步」。

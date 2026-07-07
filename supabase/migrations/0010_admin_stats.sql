-- 0010_admin_stats.sql
-- 後台數據：① admin_stats() 一次算出規模/行為/經濟/準驗的關鍵數字
--           ② daily_stats 每日快照表 ＋ 每日 cron（累積趨勢，供日後報告）
-- 全部冪等：可重跑、可貼 SQL Editor 或 db push。

-- 台灣日界：以 Asia/Taipei 當天為「今日」
create or replace function admin_stats()
returns jsonb
language sql
security definer
as $$
  select jsonb_build_object(
    -- A 規模
    'users_total',     (select count(*) from profiles),
    'users_today',     (select count(*) from profiles
                          where (created_at at time zone 'Asia/Taipei')::date
                              = (now() at time zone 'Asia/Taipei')::date),
    'users_7d_active', (select count(distinct user_id) from (
                          select user_id from casts where created_at >= now() - interval '7 days'
                          union
                          select user_id from chat_messages where created_at >= now() - interval '7 days'
                        ) a),
    -- B 行為
    'casts_total',     (select count(*) from casts),
    'casts_today',     (select count(*) from casts
                          where (created_at at time zone 'Asia/Taipei')::date
                              = (now() at time zone 'Asia/Taipei')::date),
    'followups_total', (select coalesce(sum(followup_used), 0) from casts),
    'chats_total',     (select count(*) from chat_messages where role = 'user'),
    'chats_today',     (select count(*) from chat_messages
                          where role = 'user'
                            and (created_at at time zone 'Asia/Taipei')::date
                              = (now() at time zone 'Asia/Taipei')::date),
    'casts_by_char',   (select coalesce(jsonb_object_agg(character_id, c), '{}'::jsonb)
                          from (select character_id, count(*) c from casts group by character_id) x),
    -- C 經濟
    'lingshi_balance', (select coalesce(sum(lingshi), 0) from profiles),
    'lingshi_granted', (select coalesce(sum(amount), 0) from ledger where amount > 0),
    'lingshi_spent',   (select coalesce(-sum(amount), 0) from ledger where amount < 0),
    'ledger_by_action',(select coalesce(jsonb_object_agg(action, cnt), '{}'::jsonb)
                          from (select action, count(*) cnt from ledger group by action) y),
    -- D 準驗
    'verdict_total',   (select count(*) from feedback where verdict in (1,2,3)),
    'feedback_pending',(select count(*) from feedback where verdict is null and due_date is not null)
  );
$$;

-- ② 每日快照表（趨勢來源）
create table if not exists daily_stats (
  snapshot_date date primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function snapshot_daily_stats()
returns void
language plpgsql
security definer
as $$
begin
  insert into daily_stats(snapshot_date, data)
  values ((now() at time zone 'Asia/Taipei')::date, admin_stats())
  on conflict (snapshot_date) do update set data = excluded.data, created_at = now();
end;
$$;

-- 每日台灣 23:55（= UTC 15:55）抓當日快照，幾乎滿一天
select cron.schedule(
  'daily-stats-snapshot',
  '55 15 * * *',
  $$select snapshot_daily_stats();$$
);

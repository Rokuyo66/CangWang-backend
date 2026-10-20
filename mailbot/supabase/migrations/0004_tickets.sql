-- 0004_tickets.sql — 客服紀錄
--
-- 每封寄到客服信箱的信一列。這張表是正本；Google 試算表是同步過去的副本（給觀主勾「已排除」、給 Claude 查問題）。
-- synced=false 的會在下一輪整理時補寫到試算表——試算表授權還沒設好時，紀錄也不會掉。冪等，可重跑。

create table if not exists mailbot_tickets (
  id          bigserial primary key,
  gmail_id    text not null unique,
  thread_id   text,
  received_at timestamptz not null,
  cat         text not null,
  platform    text not null default 'unknown',
  urgent      boolean not null default false,
  sender      text,
  subject     text,
  summary     text,
  synced      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists mailbot_tickets_unsynced_idx on mailbot_tickets (id) where not synced;

alter table mailbot_tickets enable row level security;
grant select, insert, update, delete on mailbot_tickets to service_role;
grant usage, select on sequence mailbot_tickets_id_seq to service_role;

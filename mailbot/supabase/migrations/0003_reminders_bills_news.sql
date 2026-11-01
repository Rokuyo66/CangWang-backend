-- 0003_reminders_bills_news.sql — 到期日提醒、帳單月報、政府消息、客服信
--
-- mailbot_reminders：從信裡抓到的日期（繳費截止、預約、到期）。前一天、當天各提醒一次，按「處理好了」就停
-- mailbot_charges  ：扣款／帳單／收據的金額，每月 1 號出月報（產品營運 vs 個人訂閱）
-- mailbot_news     ：已經推過的政府公告網址，同一則不推第二次
-- mailbot_state    ：小記事（月報這個月發過沒）
-- 冪等，可重跑。

create table if not exists mailbot_reminders (
  id              bigserial primary key,
  gmail_id        text not null unique,
  thread_id       text,
  due_date        date not null,
  what            text,
  sender          text,
  subject         text,
  notified_before boolean not null default false,   -- 前一天提醒過
  notified_day    boolean not null default false,   -- 當天提醒過
  done            boolean not null default false,   -- 觀主按了「處理好了」
  created_at      timestamptz not null default now()
);
create index if not exists mailbot_reminders_due_idx on mailbot_reminders (due_date) where not done;

create table if not exists mailbot_charges (
  id          bigserial primary key,
  gmail_id    text not null unique,
  vendor      text not null,
  currency    text not null,
  amount      numeric not null,
  twd         numeric,                               -- 換算台幣；沒有匯率的幣別留 null
  kind        text not null check (kind in ('product','personal')),
  sub         boolean not null default false,         -- 固定週期的訂閱
  charged_at  timestamptz not null,                   -- 用信的收到時間
  created_at  timestamptz not null default now()
);
create index if not exists mailbot_charges_month_idx on mailbot_charges (charged_at);

create table if not exists mailbot_news (
  url        text primary key,
  title      text,
  published  date,
  created_at timestamptz not null default now()
);

create table if not exists mailbot_state (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

alter table mailbot_reminders enable row level security;
alter table mailbot_charges   enable row level security;
alter table mailbot_news      enable row level security;
alter table mailbot_state     enable row level security;

grant select, insert, update, delete on mailbot_reminders, mailbot_charges, mailbot_news, mailbot_state to service_role;
grant usage, select on sequence mailbot_reminders_id_seq, mailbot_charges_id_seq to service_role;

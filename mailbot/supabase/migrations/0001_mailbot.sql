-- 0001_mailbot.sql — 信箱管家專案（66-butler）的全部資料表
--
-- 這是觀主私人的專案，與產品（CangWang）完全分開：產品的資料庫裡不存觀主的任何一封信。
-- 由產品專案 0091～0093 合併而來（那幾支已由產品 0094 收掉）。
-- 貼進這個專案的 SQL Editor 執行一次；冪等，可重跑。
--
-- 建專案時關掉了「Automatically expose new tables」、開了「automatic RLS」，
-- 所以每張表都要明確授權給 service_role（管家程式用的身分），anon／authenticated 一律不給。

create table if not exists mailbot_rules (
  id          bigserial primary key,
  kind        text not null check (kind in ('sender','domain','subject')),
  pattern     text not null,                 -- 一律存小寫；subject 為「包含」比對
  action      text not null check (action in ('trash','report','keep')),
  label       text,                          -- 歸檔到哪個標籤（三月/…、五年/…、永久/…）
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
  status      text not null default 'done' check (status in ('done','open')),  -- open = 歸檔卡等觀主按
  label       text,                          -- 實際歸檔到的標籤
  options     text[],                        -- 卡上的選項（⭐推薦在第一個）；按鈕只帶序號，標籤名存這裡
  suggest     text,                          -- AI 建議的新分類
  summary     text,                          -- 一句話摘要，/mailask 重推卡片時用
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists mailbot_seen_open_idx on mailbot_seen (created_at) where status = 'open';
create index if not exists mailbot_seen_created_idx on mailbot_seen (created_at);

-- 觀主在 TG 按「🆕 新分類」開出來的標籤（固定清單在 mailbot.ts 的 LABELS）
create table if not exists mailbot_labels (
  name       text primary key check (name ~ '^(三月|五年|永久)/.{2,8}$'),
  note       text,
  created_at timestamptz not null default now()
);

alter table mailbot_rules  enable row level security;
alter table mailbot_seen   enable row level security;
alter table mailbot_labels enable row level security;

grant select, insert, update, delete on mailbot_rules, mailbot_seen, mailbot_labels to service_role;
grant usage, select on sequence mailbot_rules_id_seq, mailbot_seen_id_seq to service_role;

-- 起始規則：2026-10-19 從觀主信箱實際抽樣出來的寄件人（銀行的廣告網域與交易通知網域是分開的，只刪廣告）
insert into mailbot_rules (kind, pattern, action, label, note) values
  -- 產品營運憑證：一律回報並歸檔五年
  ('sender', 'invoice+statements@mail.anthropic.com', 'report', '五年/產品營運', '起始規則：Anthropic API 收據'),
  ('domain', 'notify.cloudflare.com',                 'report', '五年/產品營運', '起始規則：Cloudflare 網域與帳單'),
  -- 銀行與保險的廣告網域
  ('domain', 'inedm.ctbcbank.com',            'trash', null, '起始規則：中信廣告'),
  ('domain', 'edm.linebank.com.tw',           'trash', null, '起始規則：LINE Bank 廣告'),
  ('domain', 'mx1.edm.sinopac.com',           'trash', null, '起始規則：永豐廣告'),
  ('domain', 'news.mybank.com.tw',            'trash', null, '起始規則：國泰廣告'),
  ('domain', 'msg.esunbank.com',              'trash', null, '起始規則：玉山廣告'),
  ('domain', 'mhurcv.taishinbank.com.tw',     'trash', null, '起始規則：台新廣告'),
  ('domain', 'mailhunter.cathaylife.com.tw',  'trash', null, '起始規則：國泰人壽廣告'),
  -- 電商、旅遊、素材站電子報
  ('domain', 'newsletter.shopee.tw',          'trash', null, '起始規則：蝦皮電子報'),
  ('sender', 'stats.spx@shopee.com',          'trash', null, '起始規則：蝦皮物流統計'),
  ('domain', 'newsletter.trip.com',           'trash', null, '起始規則：Trip.com'),
  ('domain', 'e.starlux-airlines.com',        'trash', null, '起始規則：星宇行銷'),
  ('domain', 'emktng.shutterstock.com',       'trash', null, '起始規則：Shutterstock 行銷'),
  ('domain', 'emktng.turbosquid.com',         'trash', null, '起始規則：TurboSquid 行銷'),
  ('domain', 'discover.pinterest.com',        'trash', null, '起始規則：Pinterest 推薦'),
  ('domain', 'update.pinkoi.com',             'trash', null, '起始規則：Pinkoi'),
  ('domain', 'ms1.104.com.tw',                'trash', null, '起始規則：104 電子報'),
  ('domain', 'shoplinesender.com',            'trash', null, '起始規則：Shopline 商店電子報'),
  ('domain', 'em1.cloudflare.com',            'trash', null, '起始規則：Cloudflare 行銷（帳單走 notify.cloudflare.com）'),
  -- LinkedIn 推薦與通知（真人私訊 messages-noreply 不在此列，交給 AI）
  ('sender', 'jobs-listings@linkedin.com',        'trash', null, '起始規則：LinkedIn 職缺推薦'),
  ('sender', 'jobalerts-noreply@linkedin.com',    'trash', null, '起始規則：LinkedIn 職缺通知'),
  ('sender', 'notifications-noreply@linkedin.com','trash', null, '起始規則：LinkedIn 動態通知')
on conflict (kind, pattern) do nothing;

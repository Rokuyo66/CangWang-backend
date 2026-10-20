-- 0002_rule_drafts.sql — 用說的改規則：確認卡的草稿
--
-- 觀主在 TG 打一般句子（「以後蝦皮的信都刪掉」），模型翻成規則操作存在這裡，
-- 推一張確認卡；按 ✅ 才寫進 mailbot_rules。按鈕只帶草稿 id（callback_data 上限 64 bytes）。
-- 草稿 24 小時內有效、按過即失效。冪等，可重跑。

create table if not exists mailbot_rule_drafts (
  id         bigserial primary key,
  text       text,                          -- 觀主原話，日後查「這條規則怎麼來的」
  ops        jsonb not null,                -- [{op:'add',kind,pattern,action,label}|{op:'del',id}]
  new_labels text[] not null default '{}',  -- 確認後要在 Gmail 新開的分類
  status     text not null default 'open' check (status in ('open','applied','cancelled')),
  created_at timestamptz not null default now()
);
alter table mailbot_rule_drafts enable row level security;
grant select, insert, update, delete on mailbot_rule_drafts to service_role;
grant usage, select on sequence mailbot_rule_drafts_id_seq to service_role;

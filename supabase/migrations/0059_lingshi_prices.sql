-- 0059_lingshi_prices.sql — 靈石價目表：讓「一顆石頭值多少錢」在各個出口一致
--
-- 【問題不是價格太低，是價格不一致】
--
-- 用 0043 的單價表推算每個出口的真實成本（快取命中、匯率 32），再除以扣的石數：
--
--   出口        每次成本   原扣石   每顆
--   ──────────────────────────────────────
--   起卦        NT$0.63     10     0.063   ← 最便宜
--   追問        NT$0.56      8     0.070
--   閒聊        NT$0.07      1     0.070
--   換人評卦    NT$0.49      5     0.098
--   深論        NT$2.13     15     0.142   ← 最貴，是起卦的 2.3 倍
--
-- 2.3 倍的價差意味著：同一顆免費石，倒進深論能換到的東西是倒進起卦的兩倍多。
-- 這不只是「深論賣太便宜」——它會讓成本自己往最貴的那一端滑：發出去的石頭
-- 理性上一定集中兌到深論，所以真實平均成本會比「各出口平均」更靠近 0.142。
--
-- 對齊之後（以起卦 0.063／顆為錨）：
--
--   起卦 10（不動）、追問 9（+12%）、換人評卦 8（+60%）、深論 34（+127%）、閒聊 1（不動）
--
-- 深論漲最多，因為它原本偏離最遠。以簽到日均 9.4 顆計，一次深論從「簽 1.6 天」
-- 變成「簽 3.6 天」——它本來就該是要存一陣子才捨得用的東西。
--
-- 【為什麼是資料不是程式】
--
-- 同 0043 的 model_prices 與 0058 的 plans。上線後前三個月這幾個數字一定會再調，
-- 而每調一次就要改 TypeScript、重新部署三支 function、還要擔心線上與 repo 不一致，
-- 那樣的摩擦會讓人乾脆不調。這裡改價是 update 一列，下一個請求就生效。
--
-- ⚠ 程式端（_shared/prices.ts）有一組同值的預設。讀不到這張表時用預設，
--   不會因為一次資料庫抖動就把扣費變成 0 或整個請求失敗。兩邊的值由
--   dev/pricing-test.mts 釘在一起，改了這裡沒改那裡會被測出來。

create table if not exists lingshi_prices (
  action     text primary key,   -- 與 apply_lingshi 的 p_action 同一組字
  cost       int  not null check (cost >= 0),
  label      text not null,      -- 給人看的名字（後台與對帳用）
  note       text,
  updated_at timestamptz not null default now()
);

comment on table lingshi_prices is
  '靈石價目。改價＝update 一列，下一個請求生效（程式端快取 60 秒）。'
  '程式端有同值預設，讀不到這張表時用預設——所以這裡刪列不會讓功能免費。';
comment on column lingshi_prices.action is
  '與 apply_lingshi 的 p_action 逐字對應，ledger 才對得起來。';

insert into lingshi_prices (action, cost, label, note) values
  ('extra_cast',  10, '加問一卦',   '錨點：NT$0.63／10顆＝0.063／顆，其餘出口對齊它'),
  ('followup',     9, '追問',       '原 8；NT$0.56 ÷ 0.063 ≈ 8.9'),
  ('comment',      8, '換人評卦',   '原 5；NT$0.49 ÷ 0.063 ≈ 7.8。原價每顆 0.098，偏離 1.6 倍'),
  ('deepen',      34, '展開卦理',   '原 15；NT$2.13 ÷ 0.063 ≈ 33.8。原價每顆 0.142，偏離 2.3 倍——免費石的套利出口'),
  ('chat',         1, '閒聊',       'NT$0.07／則，1 顆已是最小單位，不再往下切'),
  ('signin_mend', 10, '補簽',       '非 AI 成本，純設計值：約當一次加卦')
on conflict (action) do update
  set cost = excluded.cost, label = excluded.label, note = excluded.note, updated_at = now();

alter table lingshi_prices enable row level security;
-- 沿用 0001 的鐵則：RLS 開、零 policy ＝ 只有 service_role（Edge Function）讀得到。
-- 價目要給前端看的話走 interpret 的 bootstrap 回傳，不開 anon 直讀——
-- 直讀等於多一個不需要的攻擊面，而它換來的只是少一次已經在發生的請求。

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


-- ═══════════════════════════════════════════════════════════════════
-- 朗讀改成單次計費
--
-- 【原本的做法與它的問題】
--
-- 0043 給了每人每月一筆「字數額度」，分四階：無牒 5000、觀微 12000、
-- 知幾 30000、藏往 60000 字。以 speech-2.8-hd 約 US$0.10／千字、匯率 32 計，
-- 那是每月 NT$16／38／96／192 的純支出，而且：
--
--   一、無牒那 5000 字（NT$16／月）完全沒有收入抵。
--   二、藏往那 192 是整個方案成本裡最大的單一項——比它的 AI 成本
--       （NT$672）小，但它是唯一一項「不論訂價多少都照燒」的。
--   三、字數額度沒有人看得懂。「本月還剩 3200 字」對使用者不是資訊。
--
-- 【改成】最高階（藏往）每月給固定次數的免費朗讀，其餘一律單次收靈石。
--
-- 一次朗讀（一篇批文，約 1300 字）成本 NT$4.16。以靈石的錨點 0.063／顆換算
-- ＝ 66 顆。這個數字看起來很高，但它就是成本：朗讀一次比展開一次卦理
-- （NT$2.13）還貴一倍。定得比 66 低就是每念一次虧一次，而念得越多的人虧越多。
--
-- ⚠ 若改用 speech-2.8-turbo（MINIMAX_TTS_MODEL 環境變數，不必改程式），
--   成本約降四成 → NT$2.50／次 ＝ 40 顆。屆時把這裡 update 成 40 即可。
insert into lingshi_prices (action, cost, label, note) values
  ('tts_reading', 66, '朗讀一段',
   'NT$4.16／次（speech-2.8-hd，US$0.10／千字 × 約1300字 × 匯率32）÷ 0.063／顆。'
   '改用 turbo 模型約降四成 → 40 顆')
on conflict (action) do update
  set cost = excluded.cost, label = excluded.label, note = excluded.note, updated_at = now();

-- 最高階的免費朗讀次數。其餘階為 0——這是刻意的：朗讀要做成純收益，
-- 就不能有任何一階是「附送一點點」。附送一點點的那些階，成本照燒而使用者
-- 無感（幾千字在畫面上不是數字），兩頭都不討好。
alter table plans add column if not exists tts_free_readings int not null default 0;

comment on column plans.tts_free_readings is
  '每期致贈的免費朗讀次數。只有最高階有；其餘階一律單次扣靈石（lingshi_prices.tts_reading）。'
  '一次成本 NT$4.16，所以這個數字乘以 4.16 就是該階每月的朗讀支出上限。';

update plans set tts_free_readings = 8 where id = 'cangwang';   -- 8 × NT$4.16 ≈ NT$33／月
update plans set tts_free_readings = 0 where id in ('guanwei', 'zhiji');

-- 用量表補兩欄：次數要與字數分開記。
-- 字數仍要記——它是對帳的依據（帳單是照字數出的）。次數是計費的依據。
-- 兩個都留著，是因為「這個月念了幾次」與「這個月花了多少錢」在朗讀這件事上
-- 不成比例：一則追問兩百字、一篇批文一千三，同樣算一次。
alter table tts_usage add column if not exists readings      int not null default 0;
alter table tts_usage add column if not exists free_readings int not null default 0;

comment on column tts_usage.readings is
  '當日朗讀次數（命中快取的不算——重聽不花錢也不計費）。';
comment on column tts_usage.free_readings is
  '其中用掉免費次數的幾次。月內加總＝該月已用的免費額度。';

-- ⚠ 舊的 chars 欄位語意不變（送去雲端合成的字數），但它不再是額度的依據。
--   PLAN_TTS_CHARS 那一套在 _shared/tts.ts 已經移除。

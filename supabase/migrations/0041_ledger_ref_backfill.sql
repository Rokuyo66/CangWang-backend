-- 0041 — 加卦流水補上它買到的那支卦
--
-- 起卦的扣款發生在卦入庫之前（扣不動就不該去呼叫 AI），所以 apply_lingshi 那一刻
-- 拿不到 cast id 當 p_ref，ledger 上所有 extra_cast 的 ref_id 都是 null。往後由
-- linkLedgerRef() 在卦入庫後補接（見 pipeline.ts），這支處理的是既有的歷史資料。
--
-- 只補「一對一」的：這筆扣款後三分鐘內只有一支卦，而那支卦也只有這一筆扣款指得到。
-- 同一分鐘連起兩卦（收支頁上並排的兩筆「加卦 01:22」就是）配不出誰是誰，一律留 null。
-- 收支列表少一行問句，人只是點開看不到細節；認錯卦則是把 A 的問句掛在 B 的帳上——
-- 那是在錢的紀錄上說謊，寧可不補。

with cand as (
  select l.id as ledger_id, c.id as cast_id
  from ledger l
  join casts c
    on c.user_id = l.user_id
   and c.created_at >= l.created_at
   and c.created_at <  l.created_at + interval '3 minutes'
  where l.action = 'extra_cast' and l.ref_id is null
),
one_cast as (                      -- 這筆流水在時窗內只對到一支卦
  select ledger_id, min(cast_id) as cast_id
  from cand group by ledger_id having count(*) = 1
),
solo as (                          -- 且那支卦也只被這一筆指到
  select u.ledger_id, u.cast_id from one_cast u
  where (select count(*) from one_cast u2 where u2.cast_id = u.cast_id) = 1
)
update ledger set ref_id = solo.cast_id
from solo where ledger.id = solo.ledger_id;

-- linkLedgerRef() 每次加卦都要找「這個人這個動作、最新一筆還沒接上的」。
-- 既有索引是 (user_id, created_at desc)，帶不到 action，也帶不到 ref_id is null。
create index if not exists ledger_unlinked_idx on ledger (user_id, action, id desc)
  where ref_id is null;

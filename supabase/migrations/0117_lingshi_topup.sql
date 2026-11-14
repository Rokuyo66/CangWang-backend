-- 0117_lingshi_topup.sql — 靈石儲值：綠界一次付清（全方位金流 AIO・信用卡）
--
-- 【為什麼不塞進 0058 的 orders】
-- orders.plan 是 not null references plans(id)，而且 order_payments／apply_subscription_payment
-- 整套是為「定期定額、一期一期延牒」設計的。靈石包是一次付清、沒有期數、不動牒——
-- 硬塞進去要嘛造一個假方案，要嘛讓 plan 可為空，兩種都會讓訂閱那條路多出一個
-- 「這張單其實不是訂閱」的分支，而那條路是發牒的，最不該變複雜。
-- 所以另開兩張表、一支 RPC，回呼在同一個端點依單號分流（見 interpret ecpayReturn）。
--
-- 【冪等】綠界沒收到 1|OK 會重送。一次付清只有一期，所以冪等不需要 (交易編號, 期數)
-- 那種鍵——「status 從 pending 變成 paid」這一步本身就是鍵：條件式 update 只會成功一次，
-- 只有成功的那一次才發石。

-- ── 靈石包（價目是資料，改價＝update 一列，不必重新部署）
create table if not exists lingshi_packs (
  id         text primary key,
  label      text not null,                    -- 結帳頁與畫面上的名字
  twd        int  not null check (twd > 0),    -- 新台幣，綠界只收整數
  lingshi    int  not null check (lingshi > 0),-- 本包給幾顆（含加贈）
  bonus      int  not null default 0 check (bonus >= 0), -- 其中加贈幾顆（只用於顯示「多送 N」）
  best       boolean not null default false,             -- 畫面上框金邊的那一包
  active     boolean not null default true,
  sort       int  not null default 0,
  updated_at timestamptz not null default now(),
  check (bonus < lingshi)
);

comment on table lingshi_packs is
  '靈石儲值包。改價＝update 一列，下一張單生效；已開的單以 lingshi_orders 的快照為準。';

-- 初版價目：沿用前端方案頁「即將開放」那四格的數字（15-member-tabs.js STONE_PACKS），
-- 畫面上早已這樣標著，開賣時不換價。每顆 0.70 → 0.53 元，大包較省。
insert into lingshi_packs (id, label, twd, lingshi, best, sort) values
  ('ls_100',  '靈石一百顆',     70,   100,  false, 10),
  ('ls_300',  '靈石三百顆',     190,  300,  false, 20),
  ('ls_600',  '靈石六百顆',     350,  600,  false, 30),
  ('ls_1300', '靈石一千三百顆', 690,  1300, true,  40)
on conflict (id) do nothing;

-- ── 儲值訂單
create table if not exists lingshi_orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  pack               text not null references lingshi_packs(id),
  merchant_trade_no  text not null unique,      -- 我們產生、限 20 字英數；對帳時用這組
  amount             int  not null,             -- 成立當下的金額快照（不隨改價而變）
  lingshi            int  not null,             -- 成立當下的石數快照
  status             text not null default 'pending'
                     check (status in ('pending','paid','failed','mismatch')),   -- mismatch＝簽章對、金額不對，待人工對帳
  ecpay_trade_no     text,                      -- 綠界交易編號
  raw                jsonb,                     -- 綠界回傳原文
  paid_at            timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists lingshi_orders_user_idx on lingshi_orders (user_id, created_at desc);

comment on table lingshi_orders is
  '一次付清的靈石儲值單。status：pending→paid／failed／mismatch（金額不符，待人工對帳）；'
  'pending→paid 的條件式 update 是冪等鍵，只有它成功的那一次才發石。';

alter table lingshi_packs  enable row level security;
alter table lingshi_orders enable row level security;

-- ── 把錢變成靈石（單一交易）
--
-- 【failed 也能轉 paid】信用卡第一次授權失敗時綠界會送 RtnCode≠1，我們標 failed；
-- 但同一張單號不會再被授權成功，所以實務上不會有 failed→paid。仍然允許它，是因為
-- 「錢確實進來了（RtnCode=1、簽章對）」這件事比我們先前的標記更可信——
-- 擋掉它的結果是付了錢沒石，那才是客服案件。
create or replace function apply_lingshi_purchase(
  p_order           uuid,
  p_ecpay_trade_no  text,
  p_amount          int,
  p_raw             jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $
declare
  v_user    uuid;
  v_stones  int;
  v_amount  int;
  v_balance int;
begin
  update lingshi_orders
     set status = 'paid',
         ecpay_trade_no = p_ecpay_trade_no,
         paid_at = now(),
         raw = coalesce(p_raw, raw)
   where id = p_order and status <> 'paid'
  returning user_id, lingshi, amount into v_user, v_stones, v_amount;

  if v_user is null then
    if exists (select 1 from lingshi_orders where id = p_order) then
      return jsonb_build_object('ok', true, 'duplicate', true);   -- 重送
    end if;
    raise exception 'LINGSHI_ORDER_NOT_FOUND';
  end if;

  -- 金額不符就整筆回捲（update 也一起撤回），讓單維持原狀、留給人工對帳。
  if v_amount <> p_amount then
    raise exception 'LINGSHI_AMOUNT_MISMATCH';
  end if;

  v_balance := apply_lingshi(v_user, 'lingshi_topup', v_stones, p_order);

  return jsonb_build_object('ok', true, 'duplicate', false,
                            'lingshi_granted', v_stones, 'lingshi', v_balance);
end $$;

comment on function apply_lingshi_purchase is
  '儲值入帳：pending→paid 與發石同一交易；重送回 duplicate，不重複發石；金額不符整筆回捲。';

revoke all on function apply_lingshi_purchase(uuid, text, int, jsonb)
  from public, anon, authenticated;
grant execute on function apply_lingshi_purchase(uuid, text, int, jsonb)
  to service_role;

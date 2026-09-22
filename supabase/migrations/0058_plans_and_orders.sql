-- 0058_plans_and_orders.sql — 訂閱的資料層：方案、訂單、每期扣款
--
-- 0030 加了 profiles.plan 與 plan_until 兩個欄位，但全站沒有任何一行程式會寫它們
-- （只有 dev/yudie.ps1 手動撥）。也就是說線上每個帳號永遠是無牒，而四階額度、
-- planOf()、PLAN_* 那整套分階邏輯，至今沒有一個真實用戶走過。
--
-- 這支補上寫入的那一側：方案定義、訂單、每期扣款紀錄，以及把錢變成牒的那支函式。
-- 金流商的串接在 _shared/ecpay.ts 與 interpret 的端點，不在這裡。
--
-- 【為什麼價格是資料，不是程式】
--
-- 同 0043 的 model_prices：價格會調、會有首期優惠、會分年繳月繳。寫死在 TypeScript
-- 裡就等於每次調價都要改程式、重新部署、而且線上與 repo 有一段時間不一致。
-- 這裡改價是 update 一列。
--
-- 【定價：150／299／999，以及它是怎麼算出來的】
--
-- 定價要看成本。用 0043 的單價表推算「該階被用好用滿三十天」的每月成本
-- （快取命中、匯率 32、不含深論與換人評卦），再加上每期贈石與簽到石的兌現成本，
-- 以及朗讀（0059 之後只有最高階有免費次數）：
--
--   方案    卦/問/聊     AI    贈石   簽到   朗讀   天花板   售價   毛利
--   ─────────────────────────────────────────────────────────────────
--   無牒    2/ 1/  8     88    ——    10.8     0      99      0     ——
--   觀微    3/ 3/ 12    132    3.8   10.8     0     147    150     +3
--   知幾    5/ 5/ 30    242    9.4   10.8     0     262    299    +37
--   藏往    8/20/100    697   18.9   10.8    33     760    999   +239
--
-- 為了讓這三個價成立，同時動了三處（不是只改這張表的數字）：
--
-- 一、知幾的每日額度原本是照月費 419 訂的（5/8/50，天花板 361）。售價砍到 299
--     而額度不動的話，天花板就高過售價——而「越重度的用戶虧越多」這種虧損會
--     穩定成長，看起來卻像留存很好。改成 5/5/30（services.ts、chat.ts）。
-- 二、觀微的閒聊 20→12。追問與起卦一顆都沒動，那是升級的理由，砍了就沒有觀微了。
-- 三、簽到由 66 顆／週降為 40（prices.ts）。降的理由不是那筆錢（171 顆的兌現
--     成本是 NT$11），是它與訂閱的關係：觀微每月致贈 60 顆而簽到白給 171 顆，
--     簽七天拿到的比訂一個月還多，最低階的玉牒就沒有意義了。
--
-- 【還沒解決的兩件事，擺在這裡別忘了】
--
-- 一、觀微在天花板上只有 +3（2%）。它是把人從免費帶進付費的那一階，不是利潤
--     來源（利潤在藏往的 24%），所以打平可以接受——真的天天用滿 3 卦 3 追問的人
--     本來就該被帶去知幾。但這表示觀微沒有任何緩衝：哪天成本漲一成它就變負的。
--     要有真毛利，入門價得是 199 而不是 150。
-- 二、無牒用滿仍要 NT$99／月，而那一側完全沒有收入。目前唯一的煞車是
--     DAILY_GLOBAL_CAP（現值 200 次／日全站），那是全站共用的閘門——
--     一個人跑滿會擋到所有人。這是下一個該處理的東西。
--
-- ⚠ 「用好用滿」是天花板，不是平均。真正該照著定價的數字是 ai_cost() 的
--   by_plan.twd_per_user_per_day 與 top_users——那要等真實流量才有。
--   上線一個月後照那份數字回來調這張表（改價＝update 一列，不必出 migration）。

create table if not exists plans (
  id             text primary key,          -- 與 profiles.plan 同一組字：guanwei / zhiji / cangwang
  label          text not null,             -- 給人看的名字
  twd            int  not null,             -- 月費（新台幣，整數；綠界不收小數）
  lingshi_grant  int  not null default 0,   -- 每期入帳致贈的靈石
  blurb          text,                      -- 一句話賣點，前端方案頁用
  active         boolean not null default true,  -- 下架某一階不必刪列（歷史訂單還指著它）
  sort           int  not null default 0,
  updated_at     timestamptz not null default now()
);

comment on table plans is
  '訂閱方案。價格與贈石是資料不是程式——調價＝update 一列，不必改程式或出 migration。';
comment on column plans.active is
  'false＝不再販售，但既有訂閱仍有效、歷史訂單仍指得到。停售不要刪列。';

-- 贈石的量級：約當「該階每日免費追問用完後，還能再追問幾次」，再對齊深論的價（34 顆）——
-- 觀微 60 顆＝1.7 次深論，知幾 150＝4.4 次，藏往 300＝8.8 次。這是一條看得出階差的梯。
-- ⚠ on conflict do nothing：這張表套過一次之後，改價一律用 update，
--   不要改這段 insert——改了不會生效，而「改了沒效」最難查。
insert into plans (id, label, twd, lingshi_grant, blurb, sort) values
  ('guanwei',  '觀微', 150,  60, '每日三卦三追問，記憶加深一層',       1),
  ('zhiji',    '知幾', 299, 150, '每日五卦五追問，心跡同時記八件事',   2),
  ('cangwang', '藏往', 999, 300, '每日八卦二十追問，每月八次角色朗讀', 3)
on conflict (id) do nothing;

-- ── 訂單
--
-- 一筆訂單＝一次「去綠界結帳」的行為。定期定額成立之後，往後每期扣款記在
-- order_payments，訂單本身不再變動——把每期的錢寫回同一列，會讓「他當初買的是
-- 哪一階、多少錢」這件事被最後一期覆蓋掉，而那正是退款爭議時要查的東西。
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  plan               text not null references plans(id),

  -- 綠界的交易編號由我們產生，限 20 字、英數。訂單的天然主鍵在對帳時是這一個，
  -- 不是 uuid——出事時你跟客服對的是這組號碼。
  merchant_trade_no  text not null unique,
  amount             int  not null,          -- 成立當下的金額，不隨 plans 改價而變

  status             text not null default 'pending'
                     check (status in ('pending','active','failed','cancelled','expired')),

  -- 定期定額參數（送出時是什麼就存什麼，日後查得出當初約定的週期）
  period_type        text,                   -- 綠界：D 日 / M 月 / Y 年
  frequency          int,                    -- 每幾個 period_type 扣一次
  exec_times         int,                    -- 總共扣幾期

  ecpay_trade_no     text,                   -- 綠界那一側的交易編號
  gwsr               text,                   -- 授權碼，退刷要用
  raw                jsonb,                  -- 綠界回傳原文。對帳與爭議時唯一可信的東西
  paid_at            timestamptz,            -- 首期入帳時間
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists orders_user_idx on orders (user_id, created_at desc);
create index if not exists orders_active_idx on orders (user_id) where status = 'active';

comment on table orders is
  '一筆訂單＝一次結帳行為。往後每期扣款記在 order_payments，本表不再變動——'
  '把每期的錢寫回同一列，「他當初買的是哪一階、多少錢」會被最後一期覆蓋，而那正是爭議時要查的。';

-- ── 每期扣款
--
-- 【冪等】綠界的回呼會重送（沒收到 1|OK 就重試），同一期可能進來三四次。
-- 少了這條 unique，一期會被記成三筆、靈石發三次、牒延三個月。
-- 用「綠界交易編號 + 這是第幾期」當鍵：同一期的重送，這兩個值都一樣。
create table if not exists order_payments (
  id                 bigserial primary key,
  order_id           uuid not null references orders(id) on delete cascade,
  ecpay_trade_no     text not null,
  exec_time          int  not null,          -- 這是第幾期（綠界的 TotalSuccessTimes）
  amount             int  not null,
  paid_at            timestamptz not null default now(),
  raw                jsonb,
  created_at         timestamptz not null default now(),
  unique (ecpay_trade_no, exec_time)
);

create index if not exists order_payments_order_idx on order_payments (order_id, exec_time);

comment on table order_payments is
  '每期扣款一列。unique(ecpay_trade_no, exec_time) 是冪等的關鍵——綠界的回呼會重送，'
  '少了它一期會被記成好幾筆，靈石發好幾次、牒延好幾個月。';

-- ── RLS（沿用 0001 的鐵則）
alter table plans          enable row level security;
alter table orders         enable row level security;
alter table order_payments enable row level security;

-- ── 把錢變成牒
--
-- 【為什麼是一支 function】三件事必須一起成立：記這一期的帳、延長 plan_until、
-- 發這一期的靈石。少做任何一件，狀態就是壞的——而壞法各不相同：
-- 沒記帳＝重送時會重複發；沒延期＝付了錢沒牒；沒發石＝客服。
--
-- 【plan_until 從哪裡往後加】從「現有的 plan_until 與現在，取較晚者」。
-- 從 now() 起算的話，提前續訂的人會被吃掉剩餘天數——而提前續訂的正是最該留住的人。
create or replace function apply_subscription_payment(
  p_order            uuid,
  p_ecpay_trade_no   text,
  p_exec_time        int,
  p_amount           int,
  p_raw              jsonb default null
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_user     uuid;
  v_plan     text;
  v_grant    int;
  v_until    timestamptz;
  v_months   int;
begin
  select o.user_id, o.plan into v_user, v_plan from orders o where o.id = p_order;
  if v_user is null then
    raise exception 'SUBSCRIPTION_ORDER_NOT_FOUND';
  end if;

  -- 冪等：這一期已經記過就直接回報，不重複發石、不重複延期。
  -- 綠界沒收到 1|OK 會一直重送，所以這條路徑一定會被走到，不是理論上的。
  if exists (select 1 from order_payments
              where ecpay_trade_no = p_ecpay_trade_no and exec_time = p_exec_time) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  insert into order_payments (order_id, ecpay_trade_no, exec_time, amount, raw)
  values (p_order, p_ecpay_trade_no, p_exec_time, p_amount, p_raw);

  select coalesce(lingshi_grant, 0) into v_grant from plans where id = v_plan;

  -- 目前只賣月繳；frequency 是「每幾個月扣一次」，一期就延那麼多個月
  select coalesce(frequency, 1) into v_months from orders where id = p_order;

  select greatest(coalesce(plan_until, now()), now()) into v_until
    from profiles where id = v_user;

  update profiles
     set plan = v_plan,
         plan_until = v_until + make_interval(months => v_months)
   where id = v_user;

  update orders
     set status = 'active',
         ecpay_trade_no = coalesce(ecpay_trade_no, p_ecpay_trade_no),
         paid_at = coalesce(paid_at, now())
   where id = p_order;

  if v_grant > 0 then
    perform apply_lingshi(v_user, 'subscription', v_grant, p_order);
  end if;

  return jsonb_build_object(
    'ok', true, 'duplicate', false,
    'plan', v_plan, 'lingshi_granted', v_grant,
    'plan_until', (select plan_until from profiles where id = v_user)
  );
end $$;

comment on function apply_subscription_payment is
  '記一期扣款、延長 plan_until、發該期靈石，三件事單一交易。'
  '同一期重送（綠界會重試）直接回 duplicate，不重複生效。';

revoke all on function apply_subscription_payment(uuid, text, int, int, jsonb)
  from public, anon, authenticated;
grant execute on function apply_subscription_payment(uuid, text, int, int, jsonb)
  to service_role;

-- ⚠ 到期不另存狀態，一律看 plan_until（見 services.ts 的 planOf）。
--   這是 0030 就定下的規矩：兩份真相遲早會打架。所以這裡沒有「過期」的排程，
--   也不需要——時間到了 planOf 自然回 free。orders.status 的 'expired'
--   是給「定期定額扣完 exec_times 期、綠界不會再扣」那件事用的，與牒的效期無關。

-- 0043_ai_cost.sql — 把 ai_usage 的 token 換算成錢
--
-- 0020 開始記 ai_usage、0030 補上 cache_write/cache_read 分欄，但沒有任何一支查詢
-- 把它換算成金額——admin_stats() 的「經濟」段只有靈石，而靈石不是錢。於是
-- 「一卦成本多少」「哪個 mode 最貴」「訂閱該定價多少」全都只能用猜的。
--
-- 這支的職責就一件事：用真實 token 數 × 真實單價，算出實數。
--
-- 【設計上刻意的三件事】
--
-- 一、單價是資料，不是程式。模型會換、價格會調、還有促銷價（Sonnet 5 到
--     2026-08-31 是 $2/$10 的導入價），寫死在 SQL 裡就等於每次調價都要出一版
--     migration。改價是 update 一列。
--
-- 二、認不出來的模型會大聲叫，不會靜靜算成 0。ai_cost() 回傳裡有一段 unpriced，
--     列出所有比對不到單價的 model 與其呼叫次數。這是這支查詢最重要的一個性質：
--     一份「看起來很便宜」的成本報表，如果便宜的原因是有半數呼叫沒被計價，
--     那它比沒有報表更危險——你會照著它去定價。
--
-- 三、前綴比對、最長者勝。ai_usage.model 存的是呼叫時實際用的字串，程式裡
--     混著帶日期尾碼的（chat.ts 的 claude-haiku-4-5-20251001）與不帶的，
--     兩種都要能對到同一列單價。

-- ── 單價表（美元／百萬 token）
--
-- 快取倍率是 Anthropic 的固定規則，不是每個模型各自訂的：
--   1h 寫入 = 輸入 × 2.0（本站 CACHE_TTL 走 1h，見 services.ts）
--   5m 寫入 = 輸入 × 1.25
--   讀取    = 輸入 × 0.1
-- 這裡直接把乘完的結果存成欄位，免得查詢端還要記得乘——記得乘這種事，遲早會忘。
create table if not exists model_prices (
  model_prefix     text primary key,
  usd_in           numeric(10,4) not null,   -- 未命中快取的輸入
  usd_cache_write  numeric(10,4) not null,   -- 快取寫入（本站為 1h ＝ in × 2）
  usd_cache_read   numeric(10,4) not null,   -- 快取讀取（in × 0.1）
  usd_out          numeric(10,4) not null,
  note             text,
  updated_at       timestamptz not null default now()
);

comment on table model_prices is
  '每百萬 token 美元單價。前綴比對、最長者勝。改價＝update 一列，不必出 migration。';

insert into model_prices (model_prefix, usd_in, usd_cache_write, usd_cache_read, usd_out, note) values
  ('claude-sonnet-4-6', 3.0000, 6.0000, 0.3000, 15.0000, '起卦／追問／評卦／展開的主力'),
  ('claude-sonnet-5',   3.0000, 6.0000, 0.3000, 15.0000, '導入價 $2/$10 至 2026-08-31，屆時若仍在用需改回或確認'),
  ('claude-haiku-4-5',  1.0000, 2.0000, 0.1000,  5.0000, '閒聊主力＋日運'),
  ('claude-opus-4-8',   5.0000,10.0000, 0.5000, 25.0000, '未使用，備查'),
  ('claude-opus-5',     5.0000,10.0000, 0.5000, 25.0000, '未使用，備查'),
  -- 免費層：Groq／NVIDIA 目前零成本，但**明確列出來**而不是讓它掉進 unpriced。
  -- 「沒有價格」和「價格是零」必須分得開，否則哪天免費層開始收費，這裡不會有人發現。
  ('openai/gpt-oss',    0.0000, 0.0000, 0.0000,  0.0000, 'Groq 免費層'),
  ('meta/llama',        0.0000, 0.0000, 0.0000,  0.0000, 'NVIDIA 免費層')
on conflict (model_prefix) do nothing;

-- kimi-k2.6 故意不填：INTERPRET_FALLBACK_MODEL 真的被觸發時，它會出現在 unpriced
-- 名單上，逼人去查 Moonshot 的實際價目再補一列。填一個猜的數字進去比空著更糟。

alter table model_prices enable row level security;
-- service_role 是 Edge Function 的身分。ai_cost() 是 security definer、讀這張表不需要
-- 這道 grant，但「改價」是人會直接做的事（改一列，見上），沒有它就只能用 SQL Editor 的
-- superuser 身分改——那條路沒有履歷。
grant select, insert, update, delete on model_prices to service_role;

-- ── 單價解析：最長前綴勝
create or replace function price_of(p_model text)
returns model_prices
language sql
stable
as $$
  select * from model_prices
  where p_model like model_prefix || '%'
  order by length(model_prefix) desc
  limit 1;
$$;

-- ── 每一筆呼叫的成本（美元）。所有彙總都建在這個 view 上，換算只寫一次。
create or replace view ai_usage_cost as
select
  u.id, u.user_id, u.mode, u.model, u.estimated, u.created_at,
  u.tokens_in, u.cache_write_tokens, u.cache_read_tokens, u.tokens_out,
  -- 真實輸入量：三欄相加才是模型真的讀進去的量（見 0030 檔頭）
  (u.tokens_in + u.cache_write_tokens + u.cache_read_tokens) as tokens_in_real,
  p.model_prefix is not null as priced,
  case when p.model_prefix is null then null else round(
      u.tokens_in           / 1e6 * p.usd_in
    + u.cache_write_tokens  / 1e6 * p.usd_cache_write
    + u.cache_read_tokens   / 1e6 * p.usd_cache_read
    + u.tokens_out          / 1e6 * p.usd_out
  , 6) end as usd
from ai_usage u
left join lateral price_of(u.model) p on true;

comment on view ai_usage_cost is
  '每次 AI 呼叫的美元成本。priced=false 者 usd 為 null（不是 0）——沒有單價就不該假裝它免費。';

-- ⚠ 0036 整片鎖掉的是 function，view 不在它的射程內，而 view 預設是
--   security definer 語意（以 view 擁有者身分讀底表）——PostgREST 會把它開在
--   /rest/v1/ai_usage_cost，公開的 anon key 就能繞過 ai_usage 的 RLS 讀走全站用量。
--   這正是 0036 檔頭描述的那個洞，換成 view 再開一次。兩道都上：
--   security_invoker 讓它改以呼叫者身分讀底表（RLS 會生效），revoke 讓它根本不出現。
alter view ai_usage_cost set (security_invoker = on);
revoke all on ai_usage_cost from public, anon, authenticated;
grant select on ai_usage_cost to service_role;

-- ── 主查詢
--
-- p_days：往回幾天（預設 7）。p_twd：美元兌台幣，預設 32，匯率變動時傳參覆蓋。
--
-- 回傳的每一段都是為了回答一個具體問題：
--   by_mode   → 哪個功能最貴？一次要多少錢？（定價的直接依據）
--   by_model  → 主力與備援各佔多少
--   by_plan   → 免費用戶 vs 各級付費用戶，人均一天燒多少（訂閱定價的地板）
--   by_day    → 趨勢，以及熔斷上限抓得對不對
--   top_users → 重度用戶的實際成本（訂閱定價的天花板：這些人不能虧）
--   cache     → 快取命中率。命中率掉下來，成本會無聲上升
--   unpriced  → 沒被計價的呼叫。這段不是空的，上面所有數字就都是低估
create or replace function ai_cost(p_days int default 7, p_twd numeric default 32)
returns jsonb
language sql
security definer
as $$
  with w as (
    select * from ai_usage_cost where created_at >= now() - make_interval(days => p_days)
  ),
  active as (
    -- 這段窗內有實際用量的人數，用來算人均（不是註冊數——註冊了不用的人不花錢）
    select count(distinct user_id) n from w where user_id is not null
  )
  select jsonb_build_object(
    'window_days', p_days,
    'usd_twd',     p_twd,
    'calls',       (select count(*) from w),
    'calls_unpriced', (select count(*) from w where not priced),
    'usd',         (select coalesce(round(sum(usd), 4), 0) from w),
    'twd',         (select coalesce(round(sum(usd) * p_twd, 2), 0) from w),
    'active_users',(select n from active),
    'twd_per_active_user_per_day',
                   (select case when (select n from active) = 0 then 0 else
                      round(coalesce(sum(usd), 0) * p_twd / (select n from active) / p_days, 2)
                    end from w),

    'by_mode', (select coalesce(jsonb_object_agg(mode, j), '{}'::jsonb) from (
        select mode, jsonb_build_object(
          'calls', count(*),
          'twd',   round(coalesce(sum(usd), 0) * p_twd, 2),
          'twd_per_call', round(coalesce(avg(usd), 0) * p_twd, 4),
          'avg_in_real',  round(avg(tokens_in_real)),
          'avg_out',      round(avg(tokens_out)),
          'unpriced',     count(*) filter (where not priced)
        ) j from w group by mode) x),

    'by_model', (select coalesce(jsonb_object_agg(model, j), '{}'::jsonb) from (
        select model, jsonb_build_object(
          'calls', count(*),
          'twd',   round(coalesce(sum(usd), 0) * p_twd, 2),
          'priced', bool_and(priced)
        ) j from w group by model) x),

    'by_plan', (select coalesce(jsonb_object_agg(plan, j), '{}'::jsonb) from (
        select coalesce(pr.plan, 'unknown') plan, jsonb_build_object(
          'users', count(distinct w.user_id),
          'calls', count(*),
          'twd',   round(coalesce(sum(w.usd), 0) * p_twd, 2),
          'twd_per_user_per_day',
            round(coalesce(sum(w.usd), 0) * p_twd
                  / greatest(count(distinct w.user_id), 1) / p_days, 2)
        ) j
        from w left join profiles pr on pr.id = w.user_id
        group by coalesce(pr.plan, 'unknown')) x),

    'by_day', (select coalesce(jsonb_object_agg(d, j), '{}'::jsonb) from (
        select (created_at at time zone 'Asia/Taipei')::date::text d,
               jsonb_build_object(
                 'calls', count(*),
                 'twd',   round(coalesce(sum(usd), 0) * p_twd, 2)
               ) j
        from w group by 1) x),

    'top_users', (select coalesce(jsonb_agg(j order by (j->>'twd')::numeric desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'user_id', w.user_id,
          'plan',    coalesce(pr.plan, 'unknown'),
          'calls',   count(*),
          'twd',     round(coalesce(sum(w.usd), 0) * p_twd, 2),
          'twd_per_day', round(coalesce(sum(w.usd), 0) * p_twd / p_days, 2)
        ) j
        from w left join profiles pr on pr.id = w.user_id
        where w.user_id is not null
        group by w.user_id, pr.plan
        order by sum(w.usd) desc nulls last
        limit 10) x),

    -- 快取健康度。hit_rate 是「讀取量 ÷ 應該走快取的總量」——掉下去代表
    -- 前綴被什麼東西弄髒了（rules.ts 改一個字、persona 挪進快取斷點之前），
    -- 而那件事本身不會報錯，只會讓帳單變貴。
    'cache', (select jsonb_build_object(
        'write_tokens', coalesce(sum(cache_write_tokens), 0),
        'read_tokens',  coalesce(sum(cache_read_tokens), 0),
        'miss_tokens',  coalesce(sum(tokens_in), 0),
        'hit_rate', case when coalesce(sum(cache_write_tokens + cache_read_tokens), 0) = 0 then null
                    else round(sum(cache_read_tokens)::numeric
                             / sum(cache_write_tokens + cache_read_tokens), 4) end
      ) from w),

    'unpriced', (select coalesce(jsonb_object_agg(model, calls), '{}'::jsonb) from (
        select model, count(*) calls from w where not priced group by model) x)
  );
$$;

comment on function ai_cost is
  '近 N 天 AI 實際成本。unpriced 不為空時，其餘所有數字都是低估——先補 model_prices 再讀報表。';

-- ── 明確收權
--
-- 0036 的最後兩行本意是「往後新增的 function 自動是鎖的」，但那個機制沒有生效
-- （原因與修法見 0044）。在它修好之前，這兩支照樣會帶著預設的 PUBLIC EXECUTE 誕生，
-- 而 ai_cost() 吐的是全站營運成本與 top_users——正是 0036 想擋的那類東西。
-- 這裡不依賴 0044 的執行順序，自己把權收乾淨。
revoke all on function price_of(text) from public, anon, authenticated;
revoke all on function ai_cost(int, numeric) from public, anon, authenticated;
grant execute on function price_of(text)      to service_role;
grant execute on function ai_cost(int, numeric) to service_role;

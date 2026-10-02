-- ============================================================
-- 0078_reflection.sql
-- 回評後反芻：單卦反省、個人提醒、判法輕重；追問的反問與修正
--
-- 六六 2026-10-02：回饋的意義是讓解卦越解越準，不是收一個準不準的數字就放著。
-- 規則本文不動，變的是輕重——某條判法在印證裡老是撐不住，以後就不在第一時間拿它當主論據。
-- 程式見 functions/_shared/reflect.ts（檔頭有三層各自怎麼生效）。
--
--   ① cast_reflections / reflection_rules：一卦一份反省 + 它靠了哪幾條判法、撐住沒有
--   ② user_reading_notes：關於這個人、下次解卦要記得的一句話
--   ③ rule_priority：每條判法的加權命中數與分級（1 優先／0 常規／-1 降級）
--   ④ followups 加 ask／revision／waived：追問發現與首解前提不合時反問一句、下一次據答修正
--
-- 全部 on delete cascade 於 casts／profiles：刪卦、刪帳號會一起走。
-- 已印證的卦本來就不被 cleanup_expired_casts 清（0009），所以統計不會被週清理侵蝕；
-- 會讓統計變少的只有刪帳號——那是該少的。
-- ============================================================

create table if not exists cast_reflections (
  cast_id        uuid primary key references casts on delete cascade,
  user_id        uuid not null references profiles on delete cascade,
  verdict        smallint not null,
  attribution    text not null,        -- reflect.ts 的 ATTRIBUTIONS key
  analysis       text,                 -- 校勘者兩三句：靠什麼、結果怎麼走、落差在哪
  counterfactual text,                 -- 同一盤面換哪一判就對得上；說不出就 null
  lesson         text,                 -- 同時寫進 user_reading_notes 的那一句（留一份在這裡好對照）
  created_at     timestamptz not null default now()
);
create index if not exists cast_reflections_attr_idx on cast_reflections (attribution);

create table if not exists reflection_rules (
  cast_id  uuid not null references casts on delete cascade,
  rule_key text not null,
  role     text not null check (role in ('primary', 'secondary')),
  outcome  text not null check (outcome in ('held', 'failed', 'misapplied', 'unclear')),
  verdict  smallint not null,
  primary key (cast_id, rule_key)
);
create index if not exists reflection_rules_key_idx on reflection_rules (rule_key);

create table if not exists user_reading_notes (
  id         bigserial primary key,
  user_id    uuid not null references profiles on delete cascade,
  cast_id    uuid references casts on delete cascade,
  note       text not null,
  created_at timestamptz not null default now()
);
create index if not exists user_reading_notes_user_idx on user_reading_notes (user_id, created_at desc);

create table if not exists rule_priority (
  rule_key   text primary key,
  tier       smallint not null default 0 check (tier in (-1, 0, 1)),
  held       numeric not null default 0,   -- 加權：主論據 1、輔論據 0.5
  failed     numeric not null default 0,
  baseline   numeric,                      -- 算這一次分級時的全站命中率；樣本不足未啟動則 null
  locked     boolean not null default false,
  updated_at timestamptz not null default now()
);
comment on column rule_priority.locked is
  '人手定的分級：true 時重算不覆蓋 tier。要手動降級某條判法：update rule_priority set tier = -1, locked = true where rule_key = ''xunkong'';';

-- 聚合在這裡做：reflection_rules 會長到上萬列，從程式那邊 select 會被 db-max-rows 切掉。
-- misapplied／unclear 不計——前者是盤面讀錯（判法沒被驗到），後者是資訊不足。
create or replace function rule_stats()
returns table (rule_key text, held numeric, failed numeric)
language sql stable
as $$
  select r.rule_key,
         sum(case when r.outcome = 'held'   then (case when r.role = 'primary' then 1 else 0.5 end) else 0 end) as held,
         sum(case when r.outcome = 'failed' then (case when r.role = 'primary' then 1 else 0.5 end) else 0 end) as failed
    from reflection_rules r
   group by r.rule_key;
$$;
revoke all on function rule_stats() from public, anon, authenticated;
grant execute on function rule_stats() to service_role;

-- 給人看的一張表：在 SQL Editor 跑 select * from rule_priority_report; 就知道現在誰被降級、憑什麼。
create or replace view rule_priority_report as
  select rule_key,
         case tier when 1 then '優先' when -1 then '降級' else '常規' end as 分級,
         round(held + failed, 1) as 印證次數,
         round(held, 1)          as 撐住,
         case when held + failed > 0 then round(held / (held + failed) * 100) end as 命中率,
         round(baseline * 100)   as 全站基準,
         locked                  as 人手定,
         updated_at
    from rule_priority
   order by tier, (held + failed) desc;
-- 新建的 view 在 Supabase 預設對 anon／authenticated 開放讀取，這張只給後台看
revoke all on rule_priority_report from public, anon, authenticated;

-- 追問的反問與修正
alter table followups add column if not exists ask      text;    -- 這一答末尾向問卦人提的那一問（給他看的那句）
alter table followups add column if not exists revision text;    -- 這一答據前一問的回答所做的修正（一句：原前提→新前提）
alter table followups add column if not exists waived   boolean not null default false;  -- 回答反問的那一次，不收費

alter table cast_reflections   enable row level security;
alter table reflection_rules   enable row level security;
alter table user_reading_notes enable row level security;
alter table rule_priority      enable row level security;

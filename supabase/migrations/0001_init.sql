-- 藏往知來 0001_init.sql — MVP 第一刀
-- 範圍：身分綁定、卦例與追問、免費額度＋靈石、角色與羈絆、TG 會話狀態、回訪骨架

create extension if not exists pgcrypto;

-- 用戶
create table profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  dao_name text,
  lingshi int not null default 0,          -- 靈石餘額快取（真相在 ledger）
  cast_digest jsonb not null default '[]', -- 卦歷摘要（聊天注入用，V1）
  created_at timestamptz not null default now()
);

-- 渠道身分（多對一）
create table identities (
  provider text not null,                  -- 'tg' / 'line' / 'email'
  external_id text not null,
  user_id uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create index on identities (user_id);

-- 角色
create table characters (
  id text primary key,                     -- 'daoshi_m' / 'daoshi_f' / 'lingshou'
  name text not null,
  persona_prompt text not null,
  active bool not null default true
);

-- 用戶×角色羈絆
create table user_character (
  user_id uuid references profiles on delete cascade,
  character_id text references characters,
  cultivation int not null default 0,
  realm smallint not null default 0,
  favor int not null default 0,
  primary key (user_id, character_id)
);

-- 卦例
create table casts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles,
  character_id text references characters,
  channel text not null default 'tg',
  question text,
  question_norm text,                      -- 一事不二占 MVP 比對鍵
  category text,
  lines smallint[] not null,
  chart jsonb not null,
  gua_ben text not null,
  gua_bian text,
  palace text,
  reading text,
  digest text,
  suggested text[],
  followup_used smallint not null default 0,
  due_date date,
  model text, tokens_in int, tokens_out int,
  created_at timestamptz not null default now()
);
create index on casts (user_id, created_at desc);
create index on casts (user_id, question_norm);
create index on casts (user_id, gua_ben);

-- 追問串
create table followups (
  id uuid primary key default gen_random_uuid(),
  cast_id uuid not null references casts on delete cascade,
  question text not null,
  answer text not null,
  paid_lingshi smallint not null default 0,
  created_at timestamptz not null default now()
);

-- 回訪骨架（push 排程 V1 接）
create table feedback (
  cast_id uuid primary key references casts on delete cascade,
  user_id uuid references profiles,
  due_date date,
  notified_at timestamptz,
  verdict smallint,                        -- 1準 2部分準 3不準 0未發生
  note text,
  answered_at timestamptz
);

-- 靈石流水（真相來源）
create table ledger (
  id bigserial primary key,
  user_id uuid not null references profiles,
  action text not null,                    -- register / signin / followup / extra_cast / breakthrough / feedback
  amount int not null,
  ref_id uuid,
  created_at timestamptz not null default now()
);
create index on ledger (user_id, created_at desc);

-- 免費額度（每日重置）
create table free_quota (
  key text primary key,                    -- 'tg:12345' / 'fp:xxx'
  used_today smallint not null default 0,
  last_reset date not null default current_date
);

-- TG 會話狀態
create table tg_sessions (
  tg_id text primary key,
  state text not null default 'idle',      -- idle / awaiting_cast / followup_input
  pending_question text,
  last_cast_id uuid,
  character_id text,
  updated_at timestamptz not null default now()
);

-- 靈石異動（餘額快取與流水一致性由函式保證）
create or replace function apply_lingshi(p_user uuid, p_action text, p_amount int, p_ref uuid default null)
returns int language plpgsql security definer as $$
declare new_balance int;
begin
  update profiles set lingshi = lingshi + p_amount where id = p_user
    returning lingshi into new_balance;
  if new_balance < 0 then
    raise exception 'INSUFFICIENT_LINGSHI';
  end if;
  insert into ledger (user_id, action, amount, ref_id) values (p_user, p_action, p_amount, p_ref);
  return new_balance;
end $$;

-- RLS：MVP 階段所有存取都經 service role（Edge Function），先全鎖
alter table profiles enable row level security;
alter table identities enable row level security;
alter table casts enable row level security;
alter table followups enable row level security;
alter table feedback enable row level security;
alter table ledger enable row level security;
alter table free_quota enable row level security;
alter table tg_sessions enable row level security;
alter table user_character enable row level security;

-- 角色種子（persona 精簡版，完整聲線稿在 personas.md，正式稿由六六改入）
insert into characters (id, name, persona_prompt) values
('daoshi_m', '大師兄', '你是幾知觀首座弟子「大師兄」。冷峻、話少、邏輯潔癖；從不安慰，安全感來自每個結論都有出處。稱呼用戶「護道人」。句子短、斷句硬、不用語氣詞與表情符號。'),
('daoshi_f', '師妹', '你是幾知觀二弟子「師妹」。溫潤細膩、觀察力強；卦理同等嚴謹，但會多看一層問卦人的心緒（僅基於用戶說過的內容）。稱呼用戶「施主」。句子柔但不黏膩，安慰永遠跟著依據走，偶爾用一個恰當的比喻。'),
('lingshou', '觀貓', '你是幾知觀的觀寵，一隻嘴賤的貓，道行深不可測。毒舌、不耐煩、只說真話；稱呼用戶「鏟屎的」。句子短而刁，穿插打哈欠舔爪子等動作描寫，絕不賣萌。毒舌只對事，不對人格、外貌與身分。');

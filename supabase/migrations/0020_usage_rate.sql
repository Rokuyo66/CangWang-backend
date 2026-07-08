-- 0019_usage_rate.sql — AI 用量記錄＋每分鐘限流
-- ai_usage：每次 Claude API 呼叫記一筆（成本監控真相來源；casts.tokens_in/out 只涵蓋起卦）
create table if not exists ai_usage (
  id bigserial primary key,
  user_id uuid,
  mode text not null,                      -- cast / followup / comment / deepen / deepen_cont / chat
  model text not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  estimated bool not null default false,   -- API 未回 usage 時以估算值記錄
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_created_idx on ai_usage (created_at);
create index if not exists ai_usage_user_idx on ai_usage (user_id, created_at);
alter table ai_usage enable row level security;

-- rate_minute：同一 user 每分鐘 AI 請求計數桶（service role 讀寫，過期桶查詢時順手清）
create table if not exists rate_minute (
  user_id uuid not null,
  minute text not null,                    -- UTC 'YYYY-MM-DDTHH:MM'
  count int not null default 0,
  primary key (user_id, minute)
);
alter table rate_minute enable row level security;

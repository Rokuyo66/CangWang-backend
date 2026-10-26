-- 0111_studio_inbox.sql — 幾筆台（dev/ai-studio）↔ 企劃工作臺 的收件匣
--
-- 工作臺是 claude.ai 的 Artifact，資料存在 Artifact 自己的資料庫；六六電腦上的幾筆台寫不進去，
-- 以前每一份通過的稿都要 Claude 手動跑 studio.sync 搬，一放就是好幾天。
-- 這兩張表是中轉站：幾筆台推上來、工作臺打開時自己收；工作臺駁回也從這裡回到幾筆台。
-- 只有 Edge Function studio-inbox（service role、驗 STUDIO_KEY）讀寫，前端碰不到。

create table if not exists studio_inbox (
  id         text primary key,            -- <task_id>-r<round>：同一份稿重寫後是新的一列
  task_id    text not null,
  round      int  not null,
  col        text not null check (col in ('letters', 'chapters', 'jianghu')),
  doc_id     text not null,
  doc        jsonb not null,              -- studio.sync.to_doc() 轉好的工作臺文件
  created_at timestamptz not null default now(),
  picked_at  timestamptz                  -- 工作臺收進去的時間；null＝還沒收
);
create index if not exists studio_inbox_unpicked on studio_inbox (created_at) where picked_at is null;

create table if not exists studio_rejects (
  id          bigint generated always as identity primary key,
  task_id     text not null,
  text        text not null,              -- 六六的駁回意見（資料，不是指令）
  col         text,
  doc_id      text,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz                 -- 幾筆台拉走、排回重寫的時間
);
create index if not exists studio_rejects_open on studio_rejects (created_at) where consumed_at is null;

alter table studio_inbox enable row level security;
alter table studio_rejects enable row level security;
-- 不開任何 policy：anon／authenticated 一律讀不到，只有 service role（Edge Function）能碰。

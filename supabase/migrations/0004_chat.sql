-- 0004_chat.sql — 聊天系統
-- chat_messages：對話紀錄（記憶住這裡，與模型無關，換模型不失憶）
-- favor 欄位 user_character 已於 0001 建立，此處不重複

create table if not exists chat_messages (
  id bigserial primary key,
  user_id uuid not null references profiles on delete cascade,
  character_id text not null references characters,
  role text not null,            -- 'user' / 'assistant'
  body text not null,
  tier text,                     -- 記錄這則由哪層回應：haiku / gemini / canned（成本分析用）
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_char_idx
  on chat_messages (user_id, character_id, created_at desc);

alter table chat_messages enable row level security;

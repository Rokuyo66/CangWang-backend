-- 0023_post_comments.sql — 觀前廣場：回文＋盤面/閒聊節錄快照
-- RLS 全鎖（沿用鐵則）：前端不直連，一律走 interpret（service role）

-- 回文表：cascade 隨貼文刪除
create table if not exists post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists post_comments_post_idx on post_comments (post_id, created_at);
create index if not exists post_comments_user_idx on post_comments (user_id);
alter table post_comments enable row level security;

-- 列表用回文數（去現算：一頁 20 貼文不想多掃 comments 表）
alter table posts add column if not exists comment_count int not null default 0;

-- 閒聊節錄快照 {character_id, messages:[{me,text}...]}；與 cast_snapshot 分欄，型別不同不混用
alter table posts add column if not exists chat_snapshot jsonb;

-- 原子增減回文數（p_delta 可為負；不低於 0）
create or replace function bump_post_comment(p_post uuid, p_delta int)
returns int language plpgsql security definer as $$
declare new_count int;
begin
  update posts set comment_count = greatest(comment_count + p_delta, 0) where id = p_post
    returning comment_count into new_count;
  return new_count;
end $$;

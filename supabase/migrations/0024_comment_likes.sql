-- 0024_comment_likes.sql — 廣場回文按讚＋熱門獎勵
-- 同貼文讚的設計：複合 PK 防重、原子自增 RPC、rewarded_at 一次性發獎
-- RLS 全鎖：一律走 interpret（service role）

alter table post_comments add column if not exists like_count int not null default 0;
alter table post_comments add column if not exists rewarded_at timestamptz;

create table if not exists post_comment_likes (
  comment_id uuid not null references post_comments(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists post_comment_likes_user_idx on post_comment_likes (user_id);
alter table post_comment_likes enable row level security;

-- 內頁回文依熱度排序用
create index if not exists post_comments_hot_idx on post_comments (post_id, like_count desc, created_at);

create or replace function bump_comment_like(p_comment uuid)
returns int language plpgsql security definer as $$
declare new_count int;
begin
  update post_comments set like_count = like_count + 1 where id = p_comment
    returning like_count into new_count;
  return new_count;
end $$;

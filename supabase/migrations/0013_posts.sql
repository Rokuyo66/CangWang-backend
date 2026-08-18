-- 0022_posts.sql — 觀前廣場：公開貼文牆＋按讚
-- 型別 cast=分享卦／thread=自由心得／chat_story=聊天心得
-- RLS 全鎖（沿用本專案鐵則）：前端不直連，一律走 interpret（service role）
-- 卦分享採快照（cast_snapshot），不 live join casts；原卦刪除貼文仍在

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null check (type in ('cast','thread','chat_story')),
  title varchar(60) not null,
  body text not null,
  cast_snapshot jsonb,                      -- 分享卦快照 {question, gua_ben, gua_bian, reading}
  character_id text,                        -- 分享卦／聊天心得所屬角色（顯示用）
  like_count int not null default 0,
  rewarded_at timestamptz,                  -- 熱門獎勵發放時點（一次性；null=未發）
  created_at timestamptz not null default now()
);
create index if not exists posts_created_idx on posts (created_at desc);
create index if not exists posts_hot_idx on posts (like_count desc, created_at desc);
create index if not exists posts_user_idx on posts (user_id);

create table if not exists post_likes (
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_likes_user_idx on post_likes (user_id);

-- 原子自增讚數並回傳新值（避免併發讀後寫丟數）
create or replace function bump_post_like(p_post uuid)
returns int language plpgsql security definer as $$
declare new_count int;
begin
  update posts set like_count = like_count + 1 where id = p_post
    returning like_count into new_count;
  return new_count;
end $$;

-- RLS 全鎖：所有存取經 service role（interpret Edge Function）
alter table posts enable row level security;
alter table post_likes enable row level security;

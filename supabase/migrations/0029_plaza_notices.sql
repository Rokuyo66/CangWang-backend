-- 廣場未讀：從「一個總數」改成「哪幾則」
--
-- 原本 profiles.plaza_unread 只有一個計數，且一進「道籍 › 廣場」就整個清零。
-- 結果是：紅點亮著，但點進去看不出是哪一篇有人回你，紅點還順手消失了——
-- 提示等於沒提示。改成逐則記錄，讀哪一篇才清哪一篇。

create table if not exists plaza_notices (
  user_id    uuid not null references auth.users(id) on delete cascade,
  post_id    uuid not null references posts(id) on delete cascade,
  comment_id uuid not null references post_comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, comment_id)
);

-- 兩個查詢路徑：列表要「我在各篇各有幾則未讀」，開文要「刪掉這篇的未讀」
create index if not exists plaza_notices_user_post_idx on plaza_notices (user_id, post_id);

alter table plaza_notices enable row level security;
-- 只走 service role（Edge Function），不開放前端直連
revoke all on plaza_notices from anon, authenticated;

-- 舊的總數欄位不再寫入，一律歸零讓它退場；欄位本身保留，免得舊版前端讀到 null 出錯
update profiles set plaza_unread = 0 where plaza_unread <> 0;

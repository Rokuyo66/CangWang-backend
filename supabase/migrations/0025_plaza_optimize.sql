-- 0025_plaza_optimize.sql — 觀前廣場優化：置頂、分類篩選、回文編輯
-- RLS 全鎖沿用：所有存取經 service role（interpret Edge Function）
-- 1) 置頂：管理員可置頂貼文；pinned_at 非 null 即置頂，值為置頂時點（多篇置頂時新置頂在上）
-- 2) 回文編輯：本人可改自己的回文，edited_at 記最後編輯時點（前端顯示「編輯於」）
-- 分類篩選（cast/thread/chat_story）沿用既有 posts.type，無需改表，僅後端查詢加 eq(type)

alter table posts add column if not exists pinned_at timestamptz;
-- 列表排序：置頂優先（pinned_at desc，null 殿後），其次沿用 created_at
create index if not exists posts_pinned_idx on posts (pinned_at desc nulls last, created_at desc);
-- 分類篩選 + 最新排序複合索引（一頁 10 篇，避免全表掃）
create index if not exists posts_type_created_idx on posts (type, created_at desc);

alter table post_comments add column if not exists edited_at timestamptz;

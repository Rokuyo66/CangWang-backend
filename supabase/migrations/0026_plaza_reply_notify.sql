-- 0026_plaza_reply_notify.sql — 觀前廣場：指定回覆 + 被回覆紅點通知
-- reply_to：這則回文是「指定回覆」哪一則回文（軟參照，不設 FK 免刪除連鎖顧慮）
-- plaza_unread：被指定回覆的未讀數；>0 時前端於「會員 › 廣場」亮紅點，開該頁即清零
-- RLS 全鎖沿用：所有存取經 service role（interpret Edge Function）

alter table post_comments add column if not exists reply_to uuid;
alter table profiles add column if not exists plaza_unread int not null default 0;

-- 原子增減未讀（p_delta 可為負；不低於 0）。傳 0 可用來清零前先讀當前值
create or replace function bump_plaza_unread(p_user uuid, p_delta int)
returns int language plpgsql security definer as $$
declare new_count int;
begin
  update profiles set plaza_unread = greatest(plaza_unread + p_delta, 0) where id = p_user
    returning plaza_unread into new_count;
  return coalesce(new_count, 0);
end $$;

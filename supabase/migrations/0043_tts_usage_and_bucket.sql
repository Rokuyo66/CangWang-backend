-- 0043 — 朗讀解卦：每日字數額度與音檔桶
--
-- 為什麼要有額度：合成是要付錢的，而「念一段」這個動作按一下就發生。
-- 沒有上限的話，一個人整晚重刷就能把帳單推上去，而且是在觀主毫無所覺的情況下。
-- 額度只在真的送去合成時才扣——命中快取的重聽不算，否則等於懲罰「再聽一次」。

create table if not exists tts_usage (
  user_id uuid not null references profiles(id) on delete cascade,
  day     date not null default current_date,
  chars   integer not null default 0,
  primary key (user_id, day)
);

comment on table tts_usage is
  '每人每日送去雲端合成的字數。命中快取不計入——重聽既不花錢也不該吃額度。';

alter table tts_usage enable row level security;
-- 讀寫一律走 service role（edge function），前端不直接碰：
-- 額度自己說了算的話就不是額度了。

-- 音檔桶。公開讀取：內容是使用者自己那一卦的批文語音，鍵是
-- 模型＋聲線＋逐字文本的 SHA-256，猜不到也列不出（bucket 不開 list 權限）。
-- 走公開網址是為了讓 <audio> 直接播、也讓 CDN 快取得住——簽名網址每次都不同，
-- 等於每次重播都重新下載一份，把「快取」這件事做掉一半。
insert into storage.buckets (id, name, public)
values ('tts', 'tts', true)
on conflict (id) do update set public = true;

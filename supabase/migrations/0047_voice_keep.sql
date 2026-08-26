-- 0047_voice_keep.sql — 收藏語音改成「記一個指標」，不再複製音檔。
--
-- 0046 的設計是：前端把 mp3 上傳到私有的 voice bucket，這裡存路徑。
-- 那個設計沒有上線過，原因是它做不出來——前端手上根本沒有那個 mp3
-- （reading-tts.js 拿到的是 tts bucket 的公開網址），所以「收藏語音」
-- 那顆鈕一直沒有被做出來，而心跡的語音頁空狀態卻寫著要人去按它。
--
-- 而且就算做得出來也不該做：tts bucket 的鍵是 sha256(模型|聲線|逐字文本)、
-- cacheControl 一年，音檔本來就永久留著了。再複製一份到另一個桶，是為同一段
-- 聲音付兩份儲存費。
--
-- 現在一則收藏是「哪幾個音檔、照什麼順序播」——一個指標清單。

-- 一則收藏可能有好幾段：長批文會被切段，角色台詞與旁白還會換嗓子，
-- 每一段是 tts bucket 裡的一個檔。順序有意義，所以是陣列不是集合。
alter table voice_clips add column if not exists parts jsonb not null default '[]'::jsonb;

comment on column voice_clips.parts is
  '[{url, path, chars, narrator}, …]，照播放順序。指向 tts bucket 的共用快取；'
  '刪一則收藏**不刪音檔**——那個檔別的收藏、別人的重聽都可能指著它。';

-- 以下三欄是上傳那套的遺留，現在沒有東西會寫它們。
-- 不 drop：欄位留著，回滾才安全（drop 了要復原就得從備份撈）。
--   storage_path  改成可空——新的收藏不存單一路徑，路徑在 parts 裡
--   ready         上傳中間態。沒有上傳步驟就沒有中間態，一律視為 true
--   bytes         檔案大小。檔案不是我們存的，這個數字沒有意義
alter table voice_clips alter column storage_path drop not null;
alter table voice_clips alter column ready set default true;
update voice_clips set ready = true where ready = false;

comment on column voice_clips.ready is
  '遺留欄位。上傳那套拿掉之後沒有中間態了，新列一律 true。留著是為了回滾安全。';

comment on table voice_clips is
  '收藏的解卦語音。一列＝一則收藏，parts 指向 tts bucket 裡已經合成好的音檔。'
  '格數（PLAN_CLIPS）擋的是「再收新的」，不是「保留」與「重聽」——'
  '玉牒到期時既有收藏一段都不會消失，也不會被藏起來。';

-- voice bucket 留著不刪：它是空的（這個功能沒上線過），空桶不花錢，
-- 而從 migration 刪 storage bucket 是會連帶刪檔的動作——為了整潔冒那個險不划算。

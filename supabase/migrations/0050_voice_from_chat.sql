-- 0050_voice_from_chat.sql — 收藏語音多一個來源：閒聊裡角色說的那一句。
--
-- 為什麼要有：師兄的聲線在解卦那裡有、在閒聊裡沒有，等於同一個人在兩個地方
-- 是兩種存在。而閒聊才是人真正停留的地方——卦問完就結束，話會一直講下去。
--
-- 一列＝一則收藏，來源二選一：cast_id（批文／追問）或 message_id（閒聊那一句）。
-- 兩者都可為 null：卦刪了、對話清了，收下的聲音都還在（音檔在 tts bucket 的
-- 共用快取裡，本來就與這張表無關）。「收藏過的永遠能聽」是這一頁的承諾。
alter table voice_clips add column if not exists message_id bigint
  references chat_messages on delete set null;

create index if not exists voice_clips_message on voice_clips (message_id)
  where message_id is not null;

comment on column voice_clips.message_id is
  '閒聊來源：chat_messages.id（只會是 role=''assistant'' 那幾列——念使用者自己打的字'
  '沒有意義，卻等於開了一個「你給我文字我念給你聽」的入口）。'
  '對話清掉時設為 null，收藏不受影響。';

comment on column voice_clips.kind is
  'reading | deepen | fortune | followup | chat。chat＝收自閒聊的那一句。'
  '格數（PLAN_CLIPS）不分來源共用一份——語音收藏是一個架子，不是兩個。';

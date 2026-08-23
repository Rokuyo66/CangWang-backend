-- 道緣事件：補 summary 欄位，並把前端寫死的那三章搬進資料庫。
--
-- 為什麼現在搬：0037 建這張表的時候就寫了 scenes 欄位與它的用意，但 interpret
-- 從來沒把它吐出來過——前端讀的是 src/story/mock-events.js 裡的 MOCK_EVENTS，
-- 那個檔案自己開頭就寫著「⚠ 上線前務必移除本檔」。於是「改劇本」這件事一直是
-- 「改前端、重新打包、要使用者更新 App」，而不是「改一列資料」。
--
-- summary 是唯一缺的欄位：事件清單上那句話（「觀裡的卦書少了一冊。他為此一直
-- 沒接那個位子。」）前端一直在讀 ev.summary，表裡卻沒有對應的地方擺。
--
-- 內容原封不動搬過來，不趁機潤稿——搬家與改寫混在一起，出事時分不出是哪一邊。

alter table character_events add column if not exists summary text;

comment on column character_events.summary is
  '事件清單上顯示的一句話。不是劇透，是「這一章大概在講什麼」——'
  '玩家靠它決定要不要現在走這一章。';

-- 內容以 id 為準做 upsert：這支 migration 重跑不會長出第二份，
-- 也不會把玩家的進度（user_character_events）碰掉——那是另一張表。
insert into character_events
  (id, character_id, chapter, seq, title, summary, require_favor, require_event,
   scenes, choices, rewards, published)
values
  ('daoshi_m_c1', 'daoshi_m', 1, 1, '代理', '觀裡的卦書少了一冊。他為此一直沒接那個位子。', 0, null, '[{"bg": "guanmen", "speaker": "", "text": "觀門未闔。\n夜裡起了風，簷下的銅鈴響了兩聲，又停住。"}, {"bg": "guanmen", "portrait": "AUTO", "speaker": "大師兄", "text": "「這麼晚。」\n他沒抬頭，指節在案上叩了一下。\n「有事說事。」"}, {"bg": "cangshu", "portrait": "AUTO", "speaker": "大師兄", "text": "「觀裡的卦書，三百二十七冊。」\n「掌門走的那年，我點過一遍。」\n「少了一冊。」"}, {"bg": "cangshu", "portrait": "AUTO", "speaker": "", "text": "他終於抬眼。\n那雙眼睛裡沒有情緒，只有一種長年校對過的準確。"}, {"bg": "cangshu", "portrait": "AUTO", "speaker": "大師兄", "text": "「所以我還是代理。」\n「東西沒找齊之前，我不接那個位子。」\n「這不是謙讓，是規矩。」"}, {"bg": "houshan", "portrait": "AUTO", "speaker": "大師兄", "text": "「你要問什麼，現在問。」\n「或者——」\n他頓了一下。\n「你想知道那一冊去了哪裡。」"}]'::jsonb, '[{"key": "ask_book", "label": "我想知道那一冊去了哪裡。"}, {"key": "ask_self", "label": "我想知道你在等什麼。"}, {"key": "leave", "label": "今晚不問了。改日再來。"}]'::jsonb, '{"title": "執卷", "memory": "護道人在觀門外聽過銅鈴響的那一夜"}'::jsonb, true),
  ('daoshi_m_c2', 'daoshi_m', 2, 2, '缺頁', '那一冊的殘頁，出現在不該出現的地方。', 300, 'daoshi_m_c1', '[]'::jsonb, null, '{}'::jsonb, true),
  ('daoshi_m_c3', 'daoshi_m', 3, 3, '他的名字', '「大師兄」不是名字。是位置。', 500, 'daoshi_m_c2', '[]'::jsonb, null, '{}'::jsonb, true)
on conflict (id) do update set
  chapter       = excluded.chapter,
  seq           = excluded.seq,
  title         = excluded.title,
  summary       = excluded.summary,
  require_favor = excluded.require_favor,
  require_event = excluded.require_event,
  scenes        = excluded.scenes,
  choices       = excluded.choices,
  rewards       = excluded.rewards,
  published     = excluded.published;

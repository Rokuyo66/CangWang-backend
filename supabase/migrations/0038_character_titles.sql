-- 角色身分（稱號）：可解鎖、可切換，並會影響他說話的聲口。
--
-- 與 profiles.title_tag（玩家自己的稱號）是兩回事：那個掛在玩家頭上，
-- 這個是「你眼中的他是什麼身分」——同一個大師兄，在不同人的觀裡可以是
-- 代理掌門，也可以是掌門師兄。選用值存在 user_character.title_tag（0037 已加）。
--
-- 沿用 0034 的做法：只存文字，不存圖。底圖走九宮格，新增一個稱號的美術成本是零。

create table if not exists character_titles (
  id           text primary key,                       -- 'daoshi_m_zhangmen'
  character_id text not null references characters,
  label        text not null,                          -- 顯示用：掌門師兄
  voice_hint   text,                                   -- 注進聊天 tail 的那一句
  unlock_event text references character_events,       -- null＝預設身分，人人可用
  seq          int  not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists character_titles_pick on character_titles (character_id, seq);

alter table character_titles enable row level security;

comment on column character_titles.voice_hint is
  '⚠ 這句只能注進 chat.ts 的 tail（動態段），絕不可放進 head。'
  'head 對同一角色全站逐字相同、下了 cache_control 共用快取前綴；'
  '把隨用戶而異的稱號放進去，前綴會依稱號分岔成 N 份，命中率當場崩掉。'
  '（同樣的理由，好感數字也是被特意趕到 tail 的。）';
comment on column character_titles.unlock_event is
  '解鎖此身分的事件；null 表示預設。判定一律在伺服器——'
  '客戶端只負責顯示，不決定誰解鎖了什麼。';
comment on table character_titles is
  '⚠ 撰寫 voice_hint 的鐵則：它改的是「身分」，不是「親密度」。'
  '大師兄的好感分層（daoshiMRule）是安全機制，voice_hint 絕不可鬆動它，'
  '否則玩家能靠換身分繞過好感門檻。只寫立場、稱謂、關心的事，不寫情感尺度。';

-- ── 事件骨架先種下去，否則下面的身分掛不上 unlock_event（外鍵指向 character_events）。
-- 0037 只建表沒種資料，所以第一次跑 0038 會 FK 失敗。
--
-- 這裡種的是「章的存在」不是「章的內容」：scenes 為空陣列、published 為 false，
-- 前端因此顯示為「尚未開放」——看得到規劃、點不動。劇本寫好之後 update 這幾列即可，
-- 不必再動結構，身分的解鎖關係也不會斷。
insert into character_events (id, character_id, chapter, seq, title, require_favor, scenes, published) values
  ('daoshi_m_c1', 'daoshi_m', 1, 1, '代理',     0,   '[]'::jsonb, false),
  ('daoshi_m_c2', 'daoshi_m', 2, 1, '缺頁',     300, '[]'::jsonb, false),
  ('daoshi_m_c3', 'daoshi_m', 3, 1, '他的名字', 500, '[]'::jsonb, false)
on conflict (id) do nothing;

-- 種子：三位的預設身分（對齊前端寫死的 TITLE 表），加上大師兄第一章的解鎖身分。
-- voice_hint 刻意只有一句：夠讓他有發揮，又不會把 tail 撐大。
insert into character_titles (id, character_id, label, voice_hint, unlock_event, seq) values
  ('daoshi_m_acting',   'daoshi_m', '代理掌門',
   '你眼下只是代掌門事，位子尚未坐實。談及觀中事務時語帶保留，凡事按規矩來，不替掌門下定論。', null, 0),
  ('daoshi_m_zhangmen', 'daoshi_m', '掌門師兄',
   '你已接下掌門。話裡多了一分擔待，該拍板的事不再推諉；但你仍是那個師兄，對他的稱呼與分寸一如往常。', 'daoshi_m_c1', 1),
  ('daoshi_f_guanshi',  'daoshi_f', '幾知觀管事',
   '觀中大小雜務都經你手。你熟知誰來過、什麼東西擺在哪，說話時會不經意帶出這些瑣碎的日常。', null, 0),
  ('lingshou_chong',    'lingshou', '幾知觀寵',
   '你是觀裡輩分最高的那位，誰都得讓你三分。你懶得管事，但什麼都看在眼裡。', null, 0)
on conflict (id) do nothing;

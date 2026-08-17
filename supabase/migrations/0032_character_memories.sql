-- 0032_character_memories.sql — 記憶摘要拆成列（共憶的地基）＋ reminders 補進版控
-- RLS 全鎖：一律走 interpret（service role）
--
-- 為什麼要拆：user_character.memory_summary 是「一整段文字」，撐不起道緣名片要的
-- 逐條顯示／逐條刪除／依方案給額度／超額鎖住／刪一則後面遞補。拆成列之後這些
-- 全部只是查詢條件的事。
--
-- ⚠ 舊欄位 memory_summary 不刪（CLAUDE.md：migration 加欄位不刪欄位，回滾才安全）。
-- 後端改讀 character_memories 之後它就是死欄位，等觀察一段時間再議。

create table if not exists character_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  character_id text not null,              -- daoshi_m / daoshi_f / lingshou
  body text not null,                      -- 一則記憶，短句
  source text,                             -- chat（滾動彙整）/ cast（起卦帶出）/ reminder（託記）
  pinned_at timestamptz,                   -- 用戶釘選：永不因額度溢出而被鎖
  created_at timestamptz not null default now()
);

-- 取用序：釘選的永遠在前，其餘新到舊。額度就是這個查詢的 limit N，
-- 不落任何旗標欄位——所以「升降方案改額度」「刪一則後面遞補」全自動成立，
-- 不需要任何同步邏輯，也不會有資料與旗標不一致的可能。
create index if not exists character_memories_take_idx
  on character_memories (user_id, character_id, (pinned_at is not null) desc, created_at desc);

alter table character_memories enable row level security;

comment on table character_memories is
  '角色對用戶的長期記憶，一則一列。注入時依方案取前 N 則（釘選優先、其餘新到舊）；'
  '溢出的不刪只是不注入，補訂閱即回。取代 user_character.memory_summary 的單段文字。';
comment on column character_memories.pinned_at is
  '用戶釘選的記憶，永不因額度縮減而溢出。釘選數依方案上限，於後端檢核。';

-- 把現有的單段摘要搬成第一則記憶，否則所有人的既有記憶會在切換當下憑空消失。
-- 冪等：已經搬過的（同 user/character 有 source='migrated' 的列）不重複插。
insert into character_memories (user_id, character_id, body, source)
select uc.user_id, uc.character_id, uc.memory_summary, 'migrated'
  from user_character uc
 where uc.memory_summary is not null
   and btrim(uc.memory_summary) <> ''
   and not exists (
     select 1 from character_memories cm
      where cm.user_id = uc.user_id
        and cm.character_id = uc.character_id
        and cm.source = 'migrated'
   );

-- ── reminders：表早已在線上運作，但 SQL 一直只在家用機（被 .gitignore 排除）。
-- 現在要在它上面蓋前端 UI，「線上有、repo 沒有」就從潛在風險變成實質風險：
-- 換機器或重建環境會缺表。用 if not exists 收進版控，對線上是 no-op。
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  date date not null,                      -- 事件日期
  time text,                               -- 時間字串 "17:00"（可空）
  title text not null,                     -- 項目內容
  character_id text,                       -- 負責提醒的角色（建立時已解析為固定值）
  lead_days int not null default 0,        -- 提前 N 天開始提醒
  notified_at timestamptz,                 -- 最近一次已由角色帶到的時間（節流用）
  created_at timestamptz not null default now()
);
create index if not exists reminders_user_date on reminders(user_id, date);
alter table reminders enable row level security;

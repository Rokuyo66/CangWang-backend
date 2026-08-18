-- 道緣事件：角色個人劇情線的地基。
--
-- 與主線的分工：主線推世界、全體共通；道緣事件推「你和他」，專屬且不可逆。
-- 先做這一邊——它接得上現成的道緣分層（0/300/500/800），而道緣目前是純裝飾，
-- 累積了什麼都不會發生。事件一接上，道緣才變成真的資源。
--
-- 鐵則：獎勵一律服務端判定發放，客戶端只收結果。
-- 客戶端是不可信的執行環境，這點在網頁或 Unity 都一樣。

-- ── 事件定義（作者寫的內容，不是用戶資料）
create table if not exists character_events (
  id            text primary key,          -- 'daoshi_m_c1_e1'：角色_章_幕，看 id 就知道在哪
  character_id  text not null references characters,
  chapter       int  not null,
  seq           int  not null,
  title         text not null,
  require_favor int  not null default 0,   -- 道緣門檻（對齊 0/300/500/800）
  require_event text references character_events,  -- 前置事件；null 表示章首
  scenes        jsonb not null,            -- [{bg, portrait, expr, speaker, text}]
  choices       jsonb,                     -- [{key, label, to}]；null 表示無分支
  rewards       jsonb not null default '{}'::jsonb,
  published     bool not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists character_events_order on character_events (character_id, chapter, seq);

comment on column character_events.rewards is
  '{avatar:"r14", title:"...", name_unlock:true, naming_right:true, theme:"...", memory:"..."}；'
  '照美術鐵則：只有章末給 avatar，其餘全是文字或 CSS，零美術成本。';
comment on column character_events.scenes is
  '一幕一個物件。bg/portrait 是資產 key 不是網址——換圖不必改資料。'
  '固定的幕由人寫死；幕與幕之間角色講什麼可以讓 LLM 引用該玩家的 character_memories，'
  '同一幕每個人聽到的不一樣。這是紙嫁衣做不到、而我們做得到的地方。';

-- ── 玩家進度
create table if not exists user_character_events (
  user_id      uuid not null references profiles(id) on delete cascade,
  event_id     text not null references character_events(id),
  scene_idx    int  not null default 0,    -- 看到第幾幕（中斷可續）
  chosen       text,                       -- 選了哪個 choice.key
  completed_at timestamptz,                -- 非 null＝已完成。獎勵發放的冪等閘門
  primary key (user_id, event_id)
);
create index if not exists uce_done_idx on user_character_events (user_id, completed_at);

comment on column user_character_events.completed_at is
  '獎勵只在 null → now() 的那一次轉換中發放（同 cast_claims 的思路：'
  '用一個唯一性約束當併發仲裁者，不做事後比對）。重放請求拿不到第二份獎勵。';

-- ── 命名系統
-- 「大師兄」是代稱不是名字。事件推進後解鎖真名，或取得替他命名的權利。
alter table characters      add column if not exists real_name text;
alter table user_character  add column if not exists name_mode text not null default 'default';
alter table user_character  add column if not exists called_name text;
alter table user_character  add column if not exists title_tag text;

comment on column characters.real_name is '角色真名；未解鎖前絕不下發給前端（劇透即獎勵）';
comment on column user_character.name_mode is
  'default（大師兄）| real（真名）| custom（玩家自取，存 called_name）。'
  '⚠ 這個值必須注進 chat.ts 的 systemPrompt，否則 AI 照樣自稱大師兄，改名就成了假的。';
comment on column user_character.title_tag is
  '玩家為該角色選用的稱號（如「代理掌門」）。沿用 profiles.title_tag 的做法：只存文字，'
  '底圖走九宮格，新增一個稱號的美術成本是零。';

-- 卦案存檔：一局卦案從進案到結案的全部狀態。
--
-- 為什麼不沿用 user_character_events：那張表是章節式進度（看到第幾幕、選了哪個選項、
-- 完成沒有），一局只有「進行到哪」一個維度。卦案要記的是一個世界的切片——
-- 世界時間、人在哪一區、拿到哪些線索與道具、哪些區搜過、跟誰講過話、
-- 哪些線索因為來遲而永久錯失、觸發過哪些時間事件、一路的行動日誌。
-- 硬塞進去只會變成一堆對不上名字的欄位。
--
-- ⚠ 只存起卦的輸入（lines ＋ 進案年月日時），不存投射結果。
-- projectCase() 是純函數，存輸入就能原樣重建當局；存結果的話，往後每次調整投射
-- 邏輯（例如這次改暗動的旺）都會讓舊存檔變成髒資料——它記著一份再也重現不出來的
-- 盤面，而你無從得知它是舊邏輯還是 bug。存輸入則舊檔自動跟著新邏輯走。
--
-- 鐵則照舊：進度與獎勵一律服務端判定，客戶端只送「我做了什麼」。
-- state 整包由伺服器算完才寫回，前端送上來的 state 一律不採信。

create table if not exists case_runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  case_id      text not null,              -- 對應 _shared/cases/*.ts 的 CaseFile.id
  companion    text references characters,  -- null＝獨自前往

  -- ── 起卦輸入（重建 Chart 的全部所需）
  lines        smallint[] not null,        -- 6 值：6 老陰 7 少陽 8 少陰 9 老陽，[0]＝初爻
  entry_y      smallint not null,
  entry_m      smallint not null,
  entry_d      smallint not null,
  entry_hour   smallint,                   -- null＝不知時（core.buildChart 容許）

  -- ── 局內狀態（_shared/case-engine.ts 的 RunState 整包）
  state        jsonb not null default '{}'::jsonb,

  ended        boolean not null default false,
  solved       boolean not null default false,  -- 是否尋得關鍵線索
  kept         boolean not null default false,  -- 玩家選擇封存為記憶檔案
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint case_runs_lines_len check (array_length(lines, 1) = 6),
  constraint case_runs_lines_range check (lines <@ array[6,7,8,9]::smallint[]),
  constraint case_runs_entry_hour check (entry_hour is null or entry_hour between 0 and 23),
  constraint case_runs_entry_date check (entry_m between 1 and 12 and entry_d between 1 and 31)
);

-- 同一人同一案只准有一局進行中。沒有這條約束，前端連點兩下進案就會開出兩局，
-- 之後每次讀檔都要猜該讀哪一局——與 cast_claims 同一個思路：讓約束當仲裁者，
-- 不做事後比對。
create unique index if not exists case_runs_one_active
  on case_runs (user_id, case_id) where not ended;

-- 讀檔列表：拿某人的存檔一律照時間倒序
create index if not exists case_runs_user_idx on case_runs (user_id, created_at desc);
-- 記憶檔案配額檢查：免費 1／付費 3，各對一個同行角色
create index if not exists case_runs_kept_idx on case_runs (user_id, kept) where kept;

comment on table case_runs is
  '一局卦案的完整存檔。只存起卦輸入與局內狀態，投射結果一律由 projectCase() 現算。';
comment on column case_runs.lines is
  '三枚銅錢擲六次的結果。真隨機、零 AI、零成本——起卦不吃 token，只有解卦才吃。';
comment on column case_runs.state is
  'RunState 整包：caseId／companion／minute／startMinute／region／clues／searched／'
  'seen／talked／compFinds／lostClues／worldMarks／log／ended。'
  '整包存不拆欄位——這些欄位只有引擎讀得懂，拆出來 DB 也不會拿它們做查詢，'
  '拆了只是讓引擎每加一個欄位就要跑一次 migration。';
comment on column case_runs.kept is
  '玩家封存為記憶檔案。免費 1 格、付費 3 格（剛好三個同行角色各一）。'
  '配額滿時由玩家主動選擇捨棄哪一份，不自動覆蓋——自動洗掉的體感是刪檔，玩家會恨。';
comment on column case_runs.solved is
  '是否尋得關鍵線索。false 不等於白玩：真空局本來就允許白跑（voidPolicy=allow），'
  '同一張地圖在不同卦下對話與遭遇都不一樣，沒找到人那一趟本身就是一種結果。';

-- updated_at 自動維護：存檔每一個行動都會寫回，忘記帶 updated_at 是遲早的事
create or replace function case_runs_touch() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists case_runs_touch_trg on case_runs;
create trigger case_runs_touch_trg before update on case_runs
  for each row execute function case_runs_touch();

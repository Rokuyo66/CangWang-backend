-- 0045_xinji.sql — 心跡：把一堆孤立的卦，串成「一件事」
--
-- 起因是一個產品判斷：問卦每一卦都是孤島，而閒聊有 character_memories、有卦曆注入、
-- 有好感——人會在閒聊停下來，是因為那裡是站內唯一會累積的地方。財運與感情這兩類
-- 問得最多的事，共同結構是「同一件事會問很多次」，而 pipeline.ts 的一事不二占
-- 現在把這件事當成要擋的東西。這一版把那道牆翻成一條線。
--
-- 四張表，各自的存在理由：
--   threads         一件事。卦掛在它下面，時間軸、溫度線、月誌的「未了」都讀它。
--   casts.thread_id 卦與事的連結。set null 不 cascade——刪一條心事不該連卦一起刪。
--   thread_notes    角色留言。零 AI（規則生成），是心跡的日常黏著，不是成本。
--   monthly_reviews 月誌。**只存 AI 生成的卷首語**，統計一律現算，理由見下。

-- ═══════════════ 一、心事 ═══════════════
create table if not exists threads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles on delete cascade,
  title         text not null,                    -- 「阿凱這條線」；預設取首卦問句，可改
  subject       text,                             -- 對象／標的：「阿凱」「這間店」「那筆尾款」
  category      text,                             -- 對齊 casts.category（財/感情/事業/健康/學業/出行/其他）
  -- 首卦問句的正規化形（rules.ts normalizeQuestion）。新卦要自動歸線時比對它，
  -- 一次索引查詢就夠——不必把該用戶所有卦撈出來逐一比。
  question_norm text,
  status        text not null default 'open',     -- open | closed
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  last_cast_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table threads is
  '一件被追蹤的心事。同一件事的歷次卦掛在此下；免費 1 條在記、付費多條，額度不落資料、查詢時判。';
comment on column threads.subject is
  '對象／標的。有它才能把用神取法固定下來——rules.ts 現在得自己猜「問的是誰」，猜錯就整卦偏。';

create index if not exists threads_user_status on threads (user_id, status, last_cast_at desc nulls last);
create index if not exists threads_user_norm   on threads (user_id, question_norm);
alter table threads enable row level security;

-- ═══════════════ 二、卦掛到事上 ═══════════════
alter table casts add column if not exists thread_id uuid references threads on delete set null;
create index if not exists casts_thread on casts (thread_id, created_at desc);

comment on column casts.thread_id is
  '這一卦屬於哪件心事。null＝散卦（單次問完就結束的，多數卦都是）。'
  'on delete set null：心事刪了，卦還在——卦是他問過的事實，不該被整理動作抹掉。';

-- ═══════════════ 三、角色留言 ═══════════════
--
-- 留言是規則生成的，零 AI：條件湊齊（應期過了沒回報、一條心事十天沒動、剛結案）
-- 就從該角色的句庫挑一句。這是心跡每天打開都有東西看的來源，而它不花一毛錢。
-- 「回牠一句」才進閒聊，那時才計費——付費點落在人真的想說話的那一刻。
create table if not exists thread_notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles on delete cascade,
  thread_id    uuid references threads on delete cascade,
  character_id text not null references characters,
  kind         text not null,                     -- due_passed | gone_quiet | closed | first_cast
  body         text not null,
  cast_id      uuid references casts on delete set null,
  -- 不重複叨念的資料庫保證。形如 due:<thread>:<due_date>、quiet:<thread>:<ISO 週>。
  -- 寫在程式裡的「記得別發第二次」遲早會漏——漏的時候使用者看到的是角色跳針，
  -- 那比沒有留言更傷。唯一鍵讓第二次 insert 直接失敗。
  dedupe_key   text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  replied_at   timestamptz
);

create unique index if not exists thread_notes_dedupe on thread_notes (user_id, dedupe_key);
create index if not exists thread_notes_feed on thread_notes (user_id, created_at desc);
alter table thread_notes enable row level security;

-- ═══════════════ 四、月誌 ═══════════════
--
-- 這張表**只存卷首語**。所問、所應、未了那些統計一律查詢時現算，不落快照——
-- 理由與 case-run.ts 每次重建盤面同一條：回評會遲到（三月的卦，人四月才回報），
-- 存快照的話那一列從此與事實不符，而你無從得知它是舊資料還是 bug。
-- 現算的成本是幾個 count，換來的是「永遠對」。
--
-- 卷首語反過來必須存：它是 AI 生成的，重跑一次就是重新付一次錢，而且會變成另一段話。
create table if not exists monthly_reviews (
  user_id    uuid not null references profiles on delete cascade,
  ym         text not null,                       -- 台北月，'YYYY-MM'
  preface    text not null,
  model      text,
  tokens_in  int not null default 0,
  tokens_out int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, ym)
);

comment on table monthly_reviews is
  '月誌的卷首語（唯一的 AI 段落，每人每月一次）。統計不存這裡——現算才不會被遲到的回評弄髒。';

alter table monthly_reviews enable row level security;

-- ═══════════════ 四之二、補進版控：casts 的用神兩欄 ═══════════════
--
-- pipeline.ts 寫它、interpret 讀它、心跡的溫度線依它決定看哪一爻——但全 repo
-- 找不到建立它的 migration。它們是線上手加的，和 0032 檔頭記的 reminders 同一種情況：
-- 「表早已在線上運作，但 SQL 一直只在家用機」。
-- add column if not exists 對已存在的線上環境是 no-op，對新環境（本機、日後重建）
-- 則補上缺口——沒有它，溫度線在新環境會整條算不出來，而且不會報錯，只會是空的。
alter table casts add column if not exists yong_qin     text;
alter table casts add column if not exists yong_via_shi boolean;

comment on column casts.yong_qin is
  '解卦當下依所問之事取定的用神六親。心跡的溫度線沿用它——事後另取一個，'
  '同一條線前後就是不同基準，畫出來的起伏是假的。';

-- ═══════════════ 五、觸發器：updated_at ═══════════════
create or replace function threads_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists threads_touch_trg on threads;
create trigger threads_touch_trg before update on threads
  for each row execute function threads_touch();

-- 0044 之後新增的 function 已由全域 default privileges 收好權，這裡不必再收；
-- 但 0044 若還沒套用到線上，這一支就會帶著 PUBLIC EXECUTE 誕生。明確收一次，不賭順序。
revoke all on function threads_touch() from public, anon, authenticated;
grant execute on function threads_touch() to service_role;

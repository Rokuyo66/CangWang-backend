-- 0046_voice_and_stickers.sql — 心跡的兩件新東西：收藏語音、貼紙。
--
-- 兩件事看起來不相干，放同一支是因為它們在成本與商業模式上是同一個判斷：
--
--   語音收藏＝把已經合成好的音檔留下來。重聽不再呼叫 TTS，所以那一頁播放
--   幾百次都是零邊際成本。它同時是留存（想再聽一次師兄那句話）與訂閱誘因
--   （免費 3 段、持牒 30 段），而撐住它的是儲存費不是 AI 費——儲存費是可預期的。
--
--   貼紙＝零 AI 邊際成本的純毛利品項，和 0030 那批配色同一類，但比配色好賣：
--   配色一個帳號只買一次，貼紙是包、可以一直出新的，而且人是在「想貼」的
--   那一刻掏錢，不是在商店頁被推銷的時候。
--
-- 這兩樣加上月誌，才湊得出「訂閱不賣 AI 次數」那條線要賣的東西。

-- ═══════════════ 一、語音收藏 ═══════════════
--
-- 音檔本身進 Supabase Storage（bucket: voice，私有），這裡只存後設資料與路徑。
-- 不存 bytea：一段兩分鐘的 mp3 一兩 MB，塞進資料列會讓每一次 select 都拖著它走，
-- 而這張表最常見的查詢正是「列出我收了哪些」——那個查詢一個位元組的音訊都不需要。
create table if not exists voice_clips (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles on delete cascade,
  cast_id       uuid references casts on delete set null,   -- 卦刪了，收藏的語音還在
  character_id  text references characters,
  kind          text not null default 'reading',            -- reading | deepen | fortune | followup
  title         text not null,                              -- 「大師兄・《水天需》」
  subtitle      text,                                       -- 「那筆尾款・三月初二」
  storage_path  text not null,                              -- <uid>/<clip_id>.mp3
  duration_ms   int,
  bytes         int,
  voice_id      text,                                       -- MiniMax 音色（_shared/voices.ts）
  -- 同一段文字＋同一把嗓子＝同一個檔。收兩次不該變成兩則，也不該重新上傳一份。
  text_hash     text not null,
  -- 建立時先寫這一列（才擋得住超額），檔案上傳完才翻 true。
  -- 反過來做的話，上傳失敗會留下一則點下去沒有聲音的收藏。
  ready         boolean not null default false,
  created_at    timestamptz not null default now()
);

create unique index if not exists voice_clips_dedupe on voice_clips (user_id, text_hash);
create index if not exists voice_clips_feed on voice_clips (user_id, created_at desc);
alter table voice_clips enable row level security;

comment on table voice_clips is
  '收藏的解卦語音。音檔在 Storage 的 voice bucket，這裡只有後設資料。'
  'ready=false 是「已佔額度、檔案還沒上傳完」的中間態，列表不下發。';

-- ═══════════════ 二、貼紙 ═══════════════

create table if not exists sticker_packs (
  id       text primary key,                    -- guanzhong / miao / jieqi / zhusha
  name     text not null,
  blurb    text,
  price    int not null default 0,              -- 靈石。0＝免費，註冊即有
  sort     int not null default 0,
  active   boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists stickers (
  id      text primary key,                     -- coin / paw / seal_ying / ...
  pack_id text not null references sticker_packs on delete cascade,
  name    text not null,
  -- 前端資產鍵。圖不進資料庫——貼紙是要能換、能補、能改畫的美術資產，
  -- 進了資料庫每改一張圖就要跑一次 migration。
  asset   text not null,
  sort    int not null default 0
);
create index if not exists stickers_pack on stickers (pack_id, sort);

create table if not exists owned_packs (
  user_id     uuid not null references profiles on delete cascade,
  pack_id     text not null references sticker_packs on delete cascade,
  acquired_at timestamptz not null default now(),
  primary key (user_id, pack_id)
);

-- 貼上去的那些。
--
-- 【座標怎麼存】這是這張表唯一需要想清楚的事。
--   存絕對像素 → 換一台窄一點的手機，貼紙就跑掉。
--   全部存 0..1 相對座標 → 內容一長（時間軸新增一件心事），貼紙與它原本貼著的
--   那張卡就錯開了，而人貼的時候心裡想的是「貼在那筆尾款上」。
-- 所以用【錨點＋偏移】：
--   anchor='page'   自由貼在頁面上 → x 是寬度的 0..1，y 是距內容頂端的 px
--   anchor='thread' | 'cast' | 'note' → 貼在那張卡上，x/y 是距該元素左上角的 px，
--   允許負值（像原型裡那枚壓在卡片右上角、露出一半的銅錢）。卡片移動、
--   排序改變、內容變長，貼紙都跟著它走——那才是人以為會發生的事。
create table if not exists placed_stickers (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles on delete cascade,
  -- 貼在哪一頁：timeline / voice / thread:<uuid> / month:YYYY-MM
  surface    text not null,
  sticker_id text not null references stickers on delete cascade,
  anchor     text not null default 'page',      -- page | thread | cast | note
  anchor_id  text,                              -- anchor<>'page' 時必填
  x          real not null default 0,
  y          real not null default 0,
  rot        real not null default 0,           -- 度
  scale      real not null default 1,
  z          int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists placed_stickers_surface on placed_stickers (user_id, surface);

alter table sticker_packs   enable row level security;
alter table stickers        enable row level security;
alter table owned_packs     enable row level security;
alter table placed_stickers enable row level security;

-- ═══════════════ 三、開場的兩包 ═══════════════
--
-- 免費那包要夠用，否則貼紙這件事在人願意付錢之前就先被判定為「空的」。
-- 價錢以 0030 那批配色為尺（260～320 靈石＝約一個月的簽到量）；
-- 貼紙包比配色便宜，因為它要能一直賣，不是一次性的。
insert into sticker_packs (id, name, blurb, price, sort) values
  ('guanzhong', '觀中常備', '銅錢、印記、紙膠帶——夠你把一頁貼得像自己的', 0,   1),
  ('miao',      '觀喵の日常', '牠的爪印、牠的哈欠、牠不屑的眼神',            0,   2),
  ('jieqi',     '節氣・二十四', '立春到大寒，一節氣一張',                    160, 3),
  ('zhusha',    '硃砂印記', '應、未、吉、凶、緣、了——蓋在該蓋的地方',        120, 4)
on conflict (id) do nothing;

insert into stickers (id, pack_id, name, asset, sort) values
  ('coin',      'guanzhong', '銅錢',   'coin',      1),
  ('seal_ying', 'guanzhong', '應印',   'seal_ying', 2),
  ('star',      'guanzhong', '星',     'star',      3),
  ('cloud',     'guanzhong', '雲',     'cloud',     4),
  ('tape_pink', 'guanzhong', '紙膠帶・緋', 'tape_pink', 5),
  ('tape_green','guanzhong', '紙膠帶・青', 'tape_green',6),
  ('bookmark',  'guanzhong', '書籤',   'bookmark',  7),
  ('clock',     'guanzhong', '時辰',   'clock',     8),
  ('paw',       'miao',      '貓爪',   'paw',       1),
  ('yawn',      'miao',      '哈欠',   'yawn',      2),
  ('tail',      'miao',      '尾巴',   'tail',      3),
  ('side_eye',  'miao',      '斜眼',   'side_eye',  4)
on conflict (id) do nothing;

-- ═══════════════ 四、收權 ═══════════════
-- 0044 之後新增的 function 已由全域 default privileges 收好；這一支沒有新 function，
-- 四張表一律 RLS 開著且無 policy＝只有 service_role（Edge Function）進得去，同全站。

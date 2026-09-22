-- 0060_mail.sql — 站內信
--
-- 【為什麼要有這個東西】
--
-- 觀裡現在有三種「該讓人知道」的事，三種各自走各自的路，而其中兩種根本沒路：
--
--   一、廣場有人回你    → plaza_notices（有，紅點）
--   二、你的貼文被下架  → 沒有。0057 做了下架，但當事人不會被告知——
--                         他只會發現貼文不見了，然後以為是壞掉了
--   三、觀主想跟大家說話 → 只有 /broadcast，而那是推到 Telegram 的。
--                         網頁版的使用者收不到任何東西
--
-- 第二種是最該補的：把一個人的東西拿掉卻不告訴他，那不是內容管理，是讓人莫名其妙。
--
-- 【為什麼不擴充 plaza_notices】
--
-- 那張表的主鍵是 (user_id, comment_id)，整張表的意義就是「某人的某則回文你還沒看」。
-- 它沒有標題、沒有內文、沒有寄件人，而且一則回文只能通知一次。要把生日信塞進去，
-- 得先把它改成一張別的表——那不如另開一張。兩者各司其職：廣場紅點看 plaza_notices，
-- 信件看這裡。
--
-- 【廣播怎麼存】
--
-- 兩種做法：寫的時候展開成每人一列（fan-out），或存一列、另記誰讀過。
--
-- 選後者。前者在寄一封生日信時要寫進 N 列，而這種信一年寄三次、每次全站——
-- 寄出去那一刻會是一筆很大的寫入，而且內容重複 N 份。更麻煩的是改錯字：
-- 展開之後就改不動了，得 update N 列。
--
-- 後者的代價是讀取要 union 兩種來源，寫在 mail_list() 裡一次寫好，呼叫端不必知道。

create table if not exists mail (
  id           uuid primary key default gen_random_uuid(),

  -- null ＝ 廣播（見下方 mail_list 的可見性規則）。
  -- 不用另立 is_broadcast 欄位：兩個欄位描述同一件事，遲早會有一列說法不一致。
  user_id      uuid references profiles(id) on delete cascade,

  kind         text not null default 'system'
               check (kind in ('system','character','moderation','reward')),

  -- 誰寄的。null ＝ 觀中（系統）。有值時前端拿它去取頭像與稱呼，
  -- 所以這裡存 id 不存名字——角色改名時，舊信也跟著改。
  character_id text references characters(id),

  subject      text not null,
  body         text not null,

  -- 這封信在講哪一件東西（被下架的貼文、某一卦…）。前端可據此給一個「去看看」。
  -- 不設外鍵：指向的東西可能已經被刪了，而信不該跟著消失——
  -- 「你那篇被下架了」這句話在貼文被刪之後仍然成立。
  ref_kind     text,
  ref_id       uuid,

  created_at   timestamptz not null default now()
);

create index if not exists mail_user_idx on mail (user_id, created_at desc) where user_id is not null;
create index if not exists mail_cast_idx on mail (created_at desc) where user_id is null;

comment on table mail is
  '站內信。user_id 為 null ＝ 廣播（存一列，誰讀過記在 mail_state）。'
  'ref_kind/ref_id 刻意不設外鍵：指向的東西可能已被刪，但信不該跟著消失。';

-- ── 讀過沒、刪掉沒
--
-- 只在「這個人對這封信做過事」時才有列。沒做過事就沒有列——
-- 預設全站未讀，不必在寄信時替每個人補一列。
create table if not exists mail_state (
  user_id    uuid not null references profiles(id) on delete cascade,
  mail_id    uuid not null references mail(id) on delete cascade,
  read_at    timestamptz,
  deleted_at timestamptz,
  primary key (user_id, mail_id)
);

comment on table mail_state is
  '誰讀過／刪過哪一封。沒動過的信不會有列——預設未讀，不必在寄信時替每個人補一列。';

alter table mail       enable row level security;
alter table mail_state enable row level security;

-- ── 可見性
--
-- 【廣播只寄給「當時已經在」的人】
--
-- 判準是 mail.created_at >= profiles.created_at。少了這一條，今天註冊的人
-- 一進來就會看到過去三年的全部廣播——包含去年的生日信、前年的停機公告。
-- 那不是「完整的歷史」，那是一疊他沒有份的舊信。
create or replace function mail_list(
  p_user   uuid,
  p_limit  int default 30,
  p_offset int default 0
) returns jsonb
language sql
security definer
as $$
  with visible as (
    select m.*
      from mail m
      join profiles p on p.id = p_user
     where (m.user_id = p_user)
        or (m.user_id is null and m.created_at >= p.created_at)
  )
  select coalesce(jsonb_agg(x order by x_created desc), '[]'::jsonb) from (
    select jsonb_build_object(
             'id',      v.id,
             'kind',    v.kind,
             'from',    c.name,               -- null ＝ 觀中
             'from_id', v.character_id,
             'subject', v.subject,
             'body',    v.body,
             'ref_kind',v.ref_kind,
             'ref_id',  v.ref_id,
             'at',      v.created_at,
             'read',    s.read_at is not null
           ) as x,
           v.created_at as x_created
      from visible v
      left join mail_state s on s.mail_id = v.id and s.user_id = p_user
      left join characters c on c.id = v.character_id
     where s.deleted_at is null
     order by v.created_at desc
     limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  ) q;
$$;

comment on function mail_list is
  '某人看得到的信，新到舊。廣播只給「寄出時已經註冊」的人——'
  '少了那一條，今天註冊的人一進來就會收到過去所有的舊廣播。';

create or replace function mail_unread(p_user uuid)
returns int
language sql
security definer
as $$
  select count(*)::int
    from mail m
    join profiles p on p.id = p_user
    left join mail_state s on s.mail_id = m.id and s.user_id = p_user
   where ((m.user_id = p_user) or (m.user_id is null and m.created_at >= p.created_at))
     and s.read_at is null
     and s.deleted_at is null;
$$;

comment on function mail_unread is '未讀封數。給導覽紅點用——這支會被每次開 App 呼叫一次，所以它只數數不取內文。';

-- 讀了／刪了。兩件事共用一支：它們都是「在 mail_state 上記一筆」，
-- 分成兩支的話 upsert 的衝突處理就要寫兩遍，而那正是容易寫歪的地方。
create or replace function mail_mark(
  p_user uuid, p_mail uuid, p_read boolean default true, p_delete boolean default false
) returns void
language plpgsql
security definer
as $$
begin
  -- 先確認這個人真的看得到這封信。少了這一步，任何人都能拿別人的 mail id
  -- 來標記——雖然標記別人的信沒什麼好處，但「函式不檢查呼叫端給的 id」
  -- 是一種會被抄去別處的壞習慣。
  if not exists (
    select 1 from mail m join profiles p on p.id = p_user
     where m.id = p_mail
       and ((m.user_id = p_user) or (m.user_id is null and m.created_at >= p.created_at))
  ) then
    return;
  end if;

  insert into mail_state (user_id, mail_id, read_at, deleted_at)
  values (p_user, p_mail,
          case when p_read then now() end,
          case when p_delete then now() end)
  on conflict (user_id, mail_id) do update
    set read_at    = coalesce(mail_state.read_at, excluded.read_at),
        deleted_at = coalesce(excluded.deleted_at, mail_state.deleted_at);
end $$;

comment on function mail_mark is
  '標記已讀／刪除。已讀時間取最早的那一次（coalesce 舊值），刪除取最新的意思。';

-- 寄一封。廣播就把 p_user 留空。
create or replace function mail_send(
  p_user      uuid,
  p_subject   text,
  p_body      text,
  p_kind      text default 'system',
  p_character text default null,
  p_ref_kind  text default null,
  p_ref_id    uuid default null
) returns uuid
language plpgsql
security definer
as $$
declare v_id uuid;
begin
  insert into mail (user_id, kind, character_id, subject, body, ref_kind, ref_id)
  values (p_user, p_kind, p_character, p_subject, p_body, p_ref_kind, p_ref_id)
  returning id into v_id;
  return v_id;
end $$;

comment on function mail_send is '寄一封信。p_user 留空＝廣播（存一列，不展開成每人一列）。';

revoke all on function mail_list(uuid, int, int)                       from public, anon, authenticated;
revoke all on function mail_unread(uuid)                               from public, anon, authenticated;
revoke all on function mail_mark(uuid, uuid, boolean, boolean)         from public, anon, authenticated;
revoke all on function mail_send(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function mail_list(uuid, int, int)                       to service_role;
grant execute on function mail_unread(uuid)                               to service_role;
grant execute on function mail_mark(uuid, uuid, boolean, boolean)         to service_role;
grant execute on function mail_send(uuid, text, text, text, text, text, uuid) to service_role;

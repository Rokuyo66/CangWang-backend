-- 0066_player_titles.sql — 玩家稱號：可以擁有好幾個、可以換，角色會照它稱呼你
--
-- 【與角色身分的分別】
--   角色身分（character_titles，0038）：你眼中的他是誰——改的是「他自己的立場」
--   玩家稱號（player_titles，本檔）   ：他眼中的你是誰——改的是「他怎麼叫你」，語氣也可能跟著變
--
-- 【怎麼填】Supabase → Table Editor
--   player_titles          一列一個稱號
--     id          英數，如 zhangdeng（之後改不得，被引用著）
--     label       顯示在暱稱下的字，如「掌燈人」
--     call_as     角色預設怎麼叫你，如「掌燈的」。空白＝照舊叫暱稱
--     voice_hint  面對這個身分的你，語氣怎麼變。空白＝不變
--     note        給自己看的備註（怎麼拿到、哪一檔活動），不下發
--   player_title_voices    （選填）某個角色要叫得不一樣時才填一列
--     title_id＋character_id＋call_as／voice_hint；空白格退回 player_titles 的預設
--   user_player_titles     誰擁有哪個稱號。手動發給某人就在這裡新增一列
--   character_events.reward_player_title   了結這章送哪個稱號（下拉選 player_titles）
--
-- ⚠ voice_hint 的鐵則同 character_titles：只寫立場、稱謂、在意的事，不寫親密程度。
--   好感分層是安全機制；稱號若能讓他變熱絡，玩家換個稱號就繞過了好感門檻。
--
-- 【profiles 上的兩欄】
--   player_title  目前選用的稱號 id（新）
--   title_tag     目前選用的稱號「字」（0034 就有，廣場貼文直接讀它）——換稱號時兩欄一起寫，
--                 廣場那邊不必改。null＝預設「護道人」。

create table if not exists player_titles (
  id          text primary key check (id ~ '^[a-z0-9_]+$'),
  label       text not null,
  call_as     text,
  voice_hint  text,
  note        text,
  seq         int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists player_title_voices (
  title_id     text not null references player_titles(id) on delete cascade,
  character_id text not null references characters(id),
  call_as      text,
  voice_hint   text,
  primary key (title_id, character_id)
);

create table if not exists user_player_titles (
  user_id     uuid not null references profiles(id) on delete cascade,
  title_id    text not null references player_titles(id) on delete cascade,
  source      text,                       -- event:<id>／mail／manual……給人查帳用
  acquired_at timestamptz not null default now(),
  primary key (user_id, title_id)
);

alter table player_titles       enable row level security;
alter table player_title_voices enable row level security;
alter table user_player_titles  enable row level security;

alter table profiles add column if not exists player_title text references player_titles(id) on delete set null;

alter table character_events
  add column if not exists reward_player_title text references player_titles(id);

comment on table  player_titles              is '玩家稱號（他眼中的你）。與 character_titles（你眼中的他）是兩回事';
comment on column player_titles.id           is '英數＋底線，之後不能改（被 user_player_titles 引用）';
comment on column player_titles.label        is '顯示在暱稱下的字，如「掌燈人」';
comment on column player_titles.call_as      is '角色預設怎麼叫你。空白＝照舊叫暱稱';
comment on column player_titles.voice_hint   is '面對這個身分的你，語氣怎麼變。⚠ 只寫立場與稱謂，不寫親密程度（好感分層是安全機制）';
comment on column player_titles.note         is '備註（怎麼拿到的），不下發';
comment on table  player_title_voices        is '選填：某個角色要叫得不一樣時才填。空白格退回 player_titles 的預設';
comment on table  user_player_titles         is '誰擁有哪個稱號。手動發給某人就新增一列';
comment on column profiles.player_title      is '目前選用的玩家稱號 id；null＝預設護道人。字另存在 title_tag（廣場讀它）';
comment on column character_events.reward_player_title is '獎勵・玩家稱號（下拉選 player_titles）。空白＝不發';

-- ── 事件表單：空白格清成 null（外鍵對 '' 會存不進去）
create or replace function character_events_form_guard()
returns trigger language plpgsql as $$
begin
  if new.published and jsonb_array_length(coalesce(new.scenes, '[]'::jsonb)) = 0 then
    raise exception '「%」還沒有台詞（scenes 是空的），不能上架', new.title;
  end if;
  new.reward_avatar       := nullif(btrim(new.reward_avatar), '');
  new.reward_title        := nullif(btrim(new.reward_title),  '');
  new.reward_memory       := nullif(btrim(new.reward_memory), '');
  new.reward_player_title := nullif(btrim(new.reward_player_title), '');
  if new.reward_lingshi = 0 then new.reward_lingshi := null; end if;
  return new;
end $$;

-- ── 了結一章＋發獎：多發一個玩家稱號（其餘同 0065）
create or replace function event_complete(p_user uuid, p_event text, p_chosen text)
returns jsonb
language plpgsql
security definer
as $$
declare
  e        character_events%rowtype;
  v_n      int;
  v_bal    int;
  v_label  text;
  v_got    jsonb := '{}'::jsonb;
begin
  select * into e from character_events where id = p_event;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  insert into user_character_events (user_id, event_id, chosen)
  values (p_user, p_event, p_chosen)
  on conflict (user_id, event_id) do update set chosen = excluded.chosen;

  -- 改得到才發：重看、重放、兩支同時進來，都只有一次 row_count = 1
  update user_character_events set completed_at = now()
   where user_id = p_user and event_id = p_event and completed_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', true, 'first', false, 'rewards', '{}'::jsonb);
  end if;

  if coalesce(e.reward_lingshi, 0) > 0 then
    v_bal := apply_lingshi(p_user, 'event_reward', e.reward_lingshi);
    v_got := v_got || jsonb_build_object('lingshi', e.reward_lingshi, 'balance', v_bal);
  end if;

  if e.reward_avatar is not null then
    update profiles set claimed_rewards = claimed_rewards || array[e.reward_avatar]
     where id = p_user and not (claimed_rewards @> array[e.reward_avatar]);
    v_got := v_got || jsonb_build_object('avatar', e.reward_avatar);
  end if;

  if e.reward_title is not null then
    -- 角色身分不必另外寫：char_titles 以「unlock_event 已了結」判定解鎖，上面那一筆就是
    v_got := v_got || jsonb_build_object('title', e.reward_title);
  end if;

  if e.reward_player_title is not null then
    insert into user_player_titles (user_id, title_id, source)
    values (p_user, e.reward_player_title, 'event:' || p_event)
    on conflict do nothing;
    select label into v_label from player_titles where id = e.reward_player_title;
    v_got := v_got || jsonb_build_object('player_title', v_label);
  end if;

  if e.reward_memory is not null then
    insert into character_memories (user_id, character_id, body, source)
    values (p_user, e.character_id, e.reward_memory, 'event');
    v_got := v_got || jsonb_build_object('memory', e.reward_memory);
  end if;

  v_got := coalesce(e.rewards, '{}'::jsonb) || v_got;
  return jsonb_build_object('ok', true, 'first', true, 'rewards', v_got);
end $$;

revoke all on function event_complete(uuid, text, text) from public, anon, authenticated;
grant execute on function event_complete(uuid, text, text) to service_role;

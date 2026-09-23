-- 0065_event_form.sql — 角色事件改成「填表」：條件一欄一格、獎勵一欄一格
--
-- 【怎麼填】Supabase → Table Editor → character_events，點一列就是一張表單。
--   觸發條件（全部都要達到；0 或空白＝不限）
--     require_favor        道緣門檻
--     require_cultivation  修為門檻（新）
--     require_event        前一章（下拉選）
--   獎勵（有填才發，空白＝沒有；每人只在第一次了結時發一次）
--     reward_lingshi  靈石數
--     reward_avatar   頭像 key（r01～r13，之後新增的照 REWARD_AV 命名）
--     reward_title    他的新身分（例：掌門師兄）。填了就自動在 character_titles 生一列，
--                     玩家了結此章後可以在道籍名片上切換；聲口（voice_hint）之後再到那張表補
--     reward_memory   他會記住的一句話（寫進 character_memories，聊天時會引用）
--     rewards         其他（擴張用，JSON）。之後要加的獎勵先放這裡，用得多再升成一欄
--   上架
--     published       打勾才看得到。scenes 空著的章存不成打勾，會跳錯（見下方 trigger）
--
-- 【為什麼從 jsonb 拆成欄】
-- 原本獎勵全塞在 rewards jsonb：填的人要手寫 JSON、打錯一個逗號整列存不進去，
-- 而且 rewards.title 寫了「執卷」卻沒有任何程式讀它——看起來有獎勵，其實什麼也沒發。
-- 拆成欄之後，Table Editor 每一格就是一個輸入框，型別由資料庫擋。
--
-- 【發獎】改由 event_complete() 一支 SQL 做完：判重、記進度、發靈石、給頭像、寫記憶，
-- 同一個 transaction。原本在 edge function 裡「先查 completed_at、再 upsert」，
-- 兩支請求同時進來會都以為自己是第一次——跟 0063 mail_claim 同一個坑，同一個解法：
-- 把 completed_at 由 null 改成 now()，改得到（row_count = 1）才發。

-- ── 1. 欄位
alter table character_events
  add column if not exists require_cultivation int  not null default 0,
  add column if not exists reward_lingshi      int,
  add column if not exists reward_avatar       text,
  add column if not exists reward_title        text,
  add column if not exists reward_memory       text;

do $$ begin
  alter table character_events add constraint ce_require_cult_range  check (require_cultivation >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table character_events add constraint ce_reward_lingshi_range check (reward_lingshi is null or reward_lingshi between 0 and 1000);
exception when duplicate_object then null; end $$;

comment on column character_events.require_favor       is '觸發條件・道緣門檻。0＝不限。與其他條件是「且」';
comment on column character_events.require_cultivation is '觸發條件・修為門檻（user_character.cultivation）。0＝不限。與其他條件是「且」';
comment on column character_events.require_event       is '觸發條件・前一章要先了結。空白＝章首';
comment on column character_events.reward_lingshi      is '獎勵・靈石。空白＝不發';
comment on column character_events.reward_avatar       is '獎勵・頭像 key（r01～r13…）。空白＝不發';
comment on column character_events.reward_title        is '獎勵・他的新身分（如「掌門師兄」）。填了會自動在 character_titles 生一列，了結此章即解鎖';
comment on column character_events.reward_memory       is '獎勵・他會記住的一句話（寫進 character_memories）。空白＝不寫';
comment on column character_events.rewards             is '獎勵・其他（擴張用 JSON）。上面有欄位的別再寫在這裡';
comment on column character_events.published           is '上架。scenes 空著的章存不成 true（trigger 擋）';

-- ── 2. 舊資料搬家：大師兄第一章
-- rewards.memory → reward_memory。rewards.title「執卷」沒有任何程式讀它，
-- 而這一章實際解鎖的身分是 0038 種的「掌門師兄」——填成那個，表上寫的就是真的會發的。
update character_events
   set reward_memory = coalesce(reward_memory, rewards->>'memory'),
       reward_title  = coalesce(reward_title, '掌門師兄'),
       rewards       = rewards - 'memory' - 'title'
 where id = 'daoshi_m_c1';

-- ── 3. 空章下架（六六 2026-09-23：先不發佈）
update character_events set published = false
 where published and jsonb_array_length(coalesce(scenes, '[]'::jsonb)) = 0;

-- ── 4. 防呆：沒有台詞的章不准上架；reward_title 自動變成可切換的身分
-- character_titles.unlock_event 有外鍵指回 character_events：新章第一次存檔時那一列還不存在，
-- 所以身分的建立放在 after trigger；before trigger 只做檢查與清理。
create or replace function character_events_form_title()
returns trigger language plpgsql as $$
declare v_tid text;
begin
  if new.reward_title is null then return null; end if;
  select id into v_tid from character_titles where unlock_event = new.id order by seq limit 1;
  if v_tid is null then
    insert into character_titles (id, character_id, label, unlock_event, seq)
    values (new.id || '_title', new.character_id, new.reward_title, new.id, new.chapter)
    on conflict (id) do update set label = excluded.label, unlock_event = excluded.unlock_event;
  else
    update character_titles set label = new.reward_title where id = v_tid and label is distinct from new.reward_title;
  end if;
  return null;
end $$;

-- before：只擋與清理（身分交給上面的 after）。空字串視同沒填：Table Editor 清掉一格有時存成 ''
create or replace function character_events_form_guard()
returns trigger language plpgsql as $$
begin
  if new.published and jsonb_array_length(coalesce(new.scenes, '[]'::jsonb)) = 0 then
    raise exception '「%」還沒有台詞（scenes 是空的），不能上架', new.title;
  end if;
  new.reward_avatar := nullif(btrim(new.reward_avatar), '');
  new.reward_title  := nullif(btrim(new.reward_title),  '');
  new.reward_memory := nullif(btrim(new.reward_memory), '');
  if new.reward_lingshi = 0 then new.reward_lingshi := null; end if;
  return new;
end $$;

drop trigger if exists character_events_form_guard on character_events;
create trigger character_events_form_guard
  before insert or update on character_events
  for each row execute function character_events_form_guard();

drop trigger if exists character_events_form_title on character_events;
create trigger character_events_form_title
  after insert or update of reward_title on character_events
  for each row execute function character_events_form_title();

-- 第一章的「掌門師兄」已經在 0038 掛好，上面的 update 發生在 trigger 建立之前，不必補跑。

-- ── 5. 了結一章＋發獎（一支做完）
create or replace function event_complete(p_user uuid, p_event text, p_chosen text)
returns jsonb
language plpgsql
security definer
as $$
declare
  e        character_events%rowtype;
  v_n      int;
  v_bal    int;
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
    -- 身分不必另外寫：char_titles 以「unlock_event 已了結」判定解鎖，上面那一筆就是
    v_got := v_got || jsonb_build_object('title', e.reward_title);
  end if;

  if e.reward_memory is not null then
    insert into character_memories (user_id, character_id, body, source)
    values (p_user, e.character_id, e.reward_memory, 'event');
    v_got := v_got || jsonb_build_object('memory', e.reward_memory);
  end if;

  -- 擴張欄原樣回給前端（顯示用）；要真的發的東西，請升成一欄再寫進上面
  v_got := coalesce(e.rewards, '{}'::jsonb) || v_got;
  return jsonb_build_object('ok', true, 'first', true, 'rewards', v_got);
end $$;

comment on function event_complete is
  '了結一章並發獎。判重靠 completed_at 由 null 改成 now() 的 row_count——改得到才發。門檻由呼叫端（interpret）先驗。';

revoke all on function event_complete(uuid, text, text) from public, anon, authenticated;
grant execute on function event_complete(uuid, text, text) to service_role;

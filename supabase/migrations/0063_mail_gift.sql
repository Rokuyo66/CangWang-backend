-- 0063_mail_gift.sql — 信裡可以夾靈石
--
-- 【為什麼】
--
-- 觀中誌（更新公告）搬進站內信之後，節慶信、補償信都會走這裡——
-- 而那幾種信常常要附一點東西。原本的做法是另外跑 dev/lingshi.ps1 發放，
-- 於是「信」和「錢」是兩件事：信寄到了、錢沒發；或錢發了、人不知道為什麼多了。
-- 夾在信裡，看信的人就知道這筆是誰給的、為了什麼。
--
-- 【為什麼要「收下」而不是寄出時直接加】
--
-- 廣播存一列、不展開成每人一列（見 0060）。寄出時直接加，就得在那一刻對全站
-- 每一個人各寫一筆 ledger——正是 0060 刻意避開的那種大寫入。改成看信的人自己收，
-- 誰打開誰寫一筆，沒打開的人不佔任何東西。
--
-- 【收兩次】
--
-- 判重靠 mail_state.claimed_at：先把那一列的 claimed_at 從 null 改成 now()，
-- 改到了（row_count = 1）才發。兩支請求同時進來，只有一支改得到——
-- 不是先查再發（查與發之間有縫），是「改得到才發」。

alter table mail
  add column if not exists lingshi int not null default 0;

do $$ begin
  alter table mail add constraint mail_lingshi_range check (lingshi between 0 and 1000);
exception when duplicate_object then null; end $$;

comment on column mail.lingshi is '信裡夾的靈石。0＝沒有。收下走 mail_claim()，每人每封一次。';

alter table mail_state
  add column if not exists claimed_at timestamptz;

comment on column mail_state.claimed_at is '收下信裡的靈石的時間。null＝還沒收（或這封沒有附）。';

-- ── 清單多帶兩個欄位：附了多少、收了沒
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
             'read',    s.read_at is not null,
             'lingshi', v.lingshi,
             'claimed', s.claimed_at is not null
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

-- ── 收下
create or replace function mail_claim(p_user uuid, p_mail uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_amount  int;
  v_n       int;
  v_balance int;
begin
  -- 看得到才收得到（與 mail_mark 同一條可見性）
  select m.lingshi into v_amount
    from mail m join profiles p on p.id = p_user
   where m.id = p_mail
     and ((m.user_id = p_user) or (m.user_id is null and m.created_at >= p.created_at));
  if v_amount is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing');
  end if;

  insert into mail_state (user_id, mail_id) values (p_user, p_mail)
  on conflict (user_id, mail_id) do nothing;

  -- 改得到才發：兩支同時進來，只有一支會讓 row_count = 1
  update mail_state
     set claimed_at = now(),
         read_at    = coalesce(read_at, now())
   where user_id = p_user and mail_id = p_mail and claimed_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'claimed');
  end if;

  v_balance := apply_lingshi(p_user, 'mail_gift', v_amount, p_mail);
  return jsonb_build_object('ok', true, 'amount', v_amount, 'lingshi', v_balance);
end $$;

comment on function mail_claim is
  '收下信裡的靈石。判重靠 claimed_at 由 null 改成 now() 的 row_count——改得到才發，不是先查再發。';

-- ── 寄信：多一個 p_lingshi。
-- 舊的七參數版本要先拿掉：兩個版本並存時，用具名參數只給五個的呼叫
-- （webhook-tg、due-reminder）會對到兩支，PostgreSQL 直接報「不明確」。
drop function if exists mail_send(uuid, text, text, text, text, text, uuid);

create or replace function mail_send(
  p_user      uuid,
  p_subject   text,
  p_body      text,
  p_kind      text default 'system',
  p_character text default null,
  p_ref_kind  text default null,
  p_ref_id    uuid default null,
  p_lingshi   int  default 0
) returns uuid
language plpgsql
security definer
as $$
declare v_id uuid;
begin
  insert into mail (user_id, kind, character_id, subject, body, ref_kind, ref_id, lingshi)
  values (p_user, p_kind, p_character, p_subject, p_body, p_ref_kind, p_ref_id, greatest(0, coalesce(p_lingshi, 0)))
  returning id into v_id;
  return v_id;
end $$;

comment on function mail_send is '寄一封信。p_user 留空＝廣播（存一列，不展開成每人一列）；p_lingshi＝夾在信裡的靈石。';

revoke all on function mail_list(uuid, int, int)                                from public, anon, authenticated;
revoke all on function mail_claim(uuid, uuid)                                   from public, anon, authenticated;
revoke all on function mail_send(uuid, text, text, text, text, text, uuid, int) from public, anon, authenticated;
grant execute on function mail_list(uuid, int, int)                                to service_role;
grant execute on function mail_claim(uuid, uuid)                                   to service_role;
grant execute on function mail_send(uuid, text, text, text, text, text, uuid, int) to service_role;

-- 0106_achievements.sql — 成就榜的「問事」與「道緣」兩格（六六 2026-10-23）。
--
-- 江湖的成就是一卦一份（jianghu_claims，0095）；問事、道緣是全站一份，另開兩張表：
--   ach_progress：做過幾次（起卦、從談心起卦、從行程起卦、報三數、手動排盤、回評）。只增不減。
--   ach_claims  ：領過哪一個。主鍵＝發獎的仲裁者：插得進去才發。
--
-- 為什麼不從 casts 現算：casts 會被 cleanup_expired_casts 清掉（沒印證的過期卦），也會被玩家刪。
-- 數 casts 的話「問過幾卦」會倒退——第一百卦永遠到不了。卦鑑（0051）踩過同一個坑。
-- 規則（哪個成就、幾次、給幾顆）在 supabase/functions/_shared/achievements.ts。

-- 起卦從哪裡來、用什麼起法。前端送，後端照存；成就與日後統計都看這兩欄。
alter table casts add column if not exists cast_via    text;   -- chat（談心）｜agenda（行程）｜null（問事頁自己寫）
alter table casts add column if not exists cast_method text;   -- coin（搖卦）｜num（報三數）｜manual（手動排盤）
comment on column casts.cast_via    is '起卦入口：chat＝談心、agenda＝行程（問事頁的「從行程起題」或小工具點行程）；null＝問事頁自己寫';
comment on column casts.cast_method is '起法：coin 搖卦、num 報三數、manual 手動排盤；舊卦為 null';

create table if not exists ach_progress (
  user_id  uuid not null references profiles(id) on delete cascade,
  key      text not null,                       -- cast｜via:chat｜via:agenda｜method:num｜method:manual｜review
  n        int  not null default 0,
  first_at timestamptz not null default now(),
  primary key (user_id, key)
);
comment on table ach_progress is '成就進度：做過幾次。只增不減——卦被清、被刪都不倒退';

create table if not exists ach_claims (
  user_id uuid not null references profiles(id) on delete cascade,
  ach_id  text not null,
  amount  int  not null default 0,
  at      timestamptz not null default now(),
  primary key (user_id, ach_id)
);
comment on table ach_claims is '問事、道緣成就的領取紀錄。主鍵就是發獎的仲裁者';

alter table ach_progress enable row level security;
alter table ach_claims   enable row level security;

-- 進度 +1（一次可以加好幾個 key）
create or replace function ach_bump(p_user uuid, p_keys text[])
returns void language plpgsql security definer as $$
begin
  insert into ach_progress (user_id, key, n)
  select p_user, k, 1 from unnest(p_keys) as k where k is not null and k <> ''
  on conflict (user_id, key) do update set n = ach_progress.n + 1;
end $$;

-- 領獎。亮沒亮由 interpret 照 ach_progress／user_character_events 算；這裡只管「領過沒」與發石
create or replace function ach_claim(p_user uuid, p_ach text, p_amount int)
returns jsonb language plpgsql security definer as $$
declare v_n int; v_bal int;
begin
  insert into ach_claims (user_id, ach_id, amount) values (p_user, p_ach, greatest(p_amount, 0))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'reason', 'claimed'); end if;
  if p_amount > 0 then v_bal := apply_lingshi(p_user, 'ach', p_amount); end if;
  return jsonb_build_object('ok', true, 'amount', p_amount, 'balance', v_bal);
end $$;

revoke all on function ach_bump(uuid, text[])     from public, anon, authenticated;
revoke all on function ach_claim(uuid, text, int) from public, anon, authenticated;

-- 回填：現在還在的卦與回評（已經被清掉的找不回來，只能從這裡起算）。
-- 日運卦不算問事（同卦鑑的規矩）。從談心擬題起的卦（question_source = chat_draft）算「從談心起卦」。
insert into ach_progress (user_id, key, n, first_at)
select user_id, 'cast', count(*), min(created_at) from casts
 where user_id is not null and coalesce(category, '') <> '日運'
 group by user_id
on conflict (user_id, key) do update set n = greatest(ach_progress.n, excluded.n);

insert into ach_progress (user_id, key, n, first_at)
select user_id, 'via:chat', count(*), min(created_at) from casts
 where user_id is not null and question_source = 'chat_draft'
 group by user_id
on conflict (user_id, key) do update set n = greatest(ach_progress.n, excluded.n);

insert into ach_progress (user_id, key, n, first_at)
select user_id, 'review', count(*), min(coalesce(answered_at, now())) from feedback
 where user_id is not null and verdict in (1, 2, 3)
 group by user_id
on conflict (user_id, key) do update set n = greatest(ach_progress.n, excluded.n);

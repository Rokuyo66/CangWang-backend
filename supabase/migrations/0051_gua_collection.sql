-- 0051_gua_collection.sql — 卦鑑改成一張「收過就永遠算數」的表，不再從 casts 現算
--
-- 0015 當時的判斷是「收集靠 casts 即時算，不建擁有表」，省下一張表。
-- 省得掉的是空間，省不掉的是後果：「我收過哪些卦」因此變成一個會倒退的數字，
-- 而且有兩條路都會讓它倒退——
--   1. PostgREST 的 db-max-rows（Supabase 預設 1000）。computeCollection 那支
--      select 沒有分頁，起卦超過一千次之後，落在視窗外的卦就從卦鑑上消失，
--      收集度會隨著「用得越多」而縮水；
--   2. 刪卦（interpret 的 delete_cast）。刪掉一則問卦紀錄，等於把那一卦一併從
--      卦鑑上抹掉——但玩家刪的是「這則紀錄我不想留」，不是「這一卦我沒起過」。
--
-- 倒退的不只是數字：集滿一行解的獎勵頭像會跟著鎖回去。玩家已經領到手、已經戴在
-- 身上的頭像，在道籍換裝那一頁變成一個鎖頭——那是把已經給出去的東西收回來。
-- 「起出來的卦永遠收在鑑裡」是這一頁的承諾，承諾不能靠一張會變的表推導。
--
-- 一列＝一人收過的一卦（本卦與變卦各算一卦，與 /collection 的算法一致）。
-- 日運卦不入鑑：那是每日免費贈的今日氣象，不該拿來刷 64 卦收集進度（同 0027 的規矩）。
create table if not exists gua_collection (
  user_id  uuid not null references profiles on delete cascade,
  gua      text not null,                       -- 卦名，對 core.ts 的 ALL_GUA_NAMES
  first_at timestamptz not null default now(),  -- 初解此卦的時間（回填時取最早那一卦）
  primary key (user_id, gua)
);

alter table gua_collection enable row level security;

comment on table gua_collection is
  '卦鑑：某人收過哪些卦。只增不減——卦刪了、紀錄清了，收過的卦都還在。'
  '寫入點在 pipeline 起卦成功之後；日運卦（category=日運）不寫。';

-- 回填：把現有 casts 裡的本卦與變卦一次收進來（排除日運卦）。
-- 這一步同時把「被 db-max-rows 切掉」與「還沒被刪掉的」全部撈回，
-- 上線後玩家看到的收集度會回到他真正起過的那些卦。
insert into gua_collection (user_id, gua, first_at)
select user_id, gua, min(created_at)
from (
  select user_id, gua_ben  as gua, created_at from casts
   where gua_ben  is not null and coalesce(category, '') <> '日運'
  union all
  select user_id, gua_bian as gua, created_at from casts
   where gua_bian is not null and coalesce(category, '') <> '日運'
) t
where user_id is not null and gua <> ''
group by user_id, gua
on conflict (user_id, gua) do nothing;

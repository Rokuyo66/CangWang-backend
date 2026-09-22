-- 0057_reports_and_blocks.sql — 廣場的檢舉、封鎖與下架
--
-- 觀前廣場是公開 UGC（貼文、回文、按讚），而目前唯一的管理手段是 ADMIN_USER_ID
-- 直接刪文——使用者這一側什麼都沒有：看到不該看的東西，沒有地方說；被同一個人
-- 一路跟著騷擾，沒有辦法讓他消失。
--
-- 這不只是體驗問題。App Store 與 Google Play 對「使用者產生內容」有硬性要求：
-- 要有檢舉機制、要有封鎖機制、要有下架的手段。缺一項就是上架被擋。
--
-- 【三張表各自回答一個問題】
--
--   reports  有人覺得這則不該在這裡  → 觀主要看得到、處理得掉
--   blocks   我不想再看到這個人      → 不必等觀主，自己就能解決
--   hidden_at（欄位，不是表）下架了 → 但留著，不是刪掉
--
-- 【為什麼下架是軟刪除】
--
-- 硬刪掉最省事，但三件事會做不到：駁回之後救不回來（誤判就是永久的）、
-- 同一個人反覆違規時看不出累犯、以及真的出事時沒有任何證據留著。
-- hidden_at 讓「看不到」與「不存在」分開——前台一律過濾，資料還在。

-- ── 一、檢舉
create table if not exists reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid not null references profiles(id) on delete cascade,
  target_type   text not null check (target_type in ('post', 'comment')),
  target_id     uuid not null,
  -- 分類收斂成固定幾項，不讓使用者自由填：自由填的分類沒辦法統計，
  -- 而「哪一類最多」正是之後決定要不要做自動化的依據。
  --   spam     廣告、洗版
  --   abuse    人身攻擊、騷擾
  --   sexual   情色或不當內容
  --   selfharm 自傷或輕生內容 ← 見下方【這一類要特別處理】
  --   privacy  洩漏他人個資
  --   other    其他（此時 note 才真的重要）
  reason        text not null check (reason in ('spam','abuse','sexual','selfharm','privacy','other')),
  note          text,                                    -- 選填補充，上限由端點管
  status        text not null default 'open'
                check (status in ('open','actioned','dismissed')),
  handled_at    timestamptz,
  handled_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- 同一個人對同一則只算一次。少了這條，一個人可以自己按十次檢舉把東西頂上去，
  -- 而「被幾個人檢舉」這個數字就再也沒有意義。
  unique (reporter_id, target_type, target_id)
);

-- 待處理清單按時間排（/reports 與推播補送都用這條）
create index if not exists reports_open_idx on reports (created_at desc) where status = 'open';
-- 「這一則被幾個人檢舉」：自動化那一步真的要做時，數的是這個
create index if not exists reports_target_idx on reports (target_type, target_id);

comment on table reports is
  '廣場檢舉。同一人對同一則只能檢舉一次（unique），故 count(*) 即為「幾個人檢舉」。';

-- ── 二、封鎖
--
-- 單向：我封鎖他，我就看不到他的貼文與回文；他那邊沒有任何提示，也看不出被封鎖。
-- 不做成雙向消失，是因為那等於讓任何人都能片面把自己從別人的視野裡刪掉——
-- 檢舉才是處理「他不該在這裡」的路，封鎖只處理「我不想看」。
create table if not exists blocks (
  user_id     uuid not null references profiles(id) on delete cascade,  -- 封鎖的人
  blocked_id  uuid not null references profiles(id) on delete cascade,  -- 被封鎖的人
  created_at  timestamptz not null default now(),
  primary key (user_id, blocked_id),
  constraint blocks_not_self check (user_id <> blocked_id)
);

-- 每次開廣場都要撈「我封鎖了誰」，這條索引就是為它建的
create index if not exists blocks_user_idx on blocks (user_id);

comment on table blocks is
  '單向封鎖：user_id 看不到 blocked_id 的貼文與回文；被封鎖者無感知。';

-- ── 三、下架（軟刪除）
alter table posts         add column if not exists hidden_at timestamptz;
alter table post_comments add column if not exists hidden_at timestamptz;

comment on column posts.hidden_at is
  '下架時點。null＝正常顯示。前台一律過濾，資料保留——駁回要救得回來，累犯要看得出來。';

-- 列表查詢一律帶 hidden_at is null，走部分索引才不會每次全表掃
create index if not exists posts_visible_idx
  on posts (created_at desc) where hidden_at is null;
create index if not exists post_comments_visible_idx
  on post_comments (post_id, created_at) where hidden_at is null;

-- ── 四、RLS（沿用 0001 的鐵則：開著、零 policy、只走 service role）
alter table reports enable row level security;
alter table blocks  enable row level security;

-- ── 五、下架與回復
--
-- 為什麼要一支 function：下架不只是把 hidden_at 填上——回文數、讚數這些反正規化的
-- 欄位要跟著動，相關的檢舉要一起結案，而這幾件事必須一起成立。散在端點裡寫，
-- 第二個呼叫端出現時就會少做一樣。
--
-- p_hide = true 下架、false 回復。回傳受影響的筆數供呼叫端回話用。
create or replace function moderate_target(
  p_type text, p_id uuid, p_hide boolean, p_admin uuid
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_found int := 0;
  v_post  uuid;
begin
  if p_type not in ('post', 'comment') then
    raise exception 'MODERATE_BAD_TYPE';
  end if;

  if p_type = 'post' then
    update posts set hidden_at = case when p_hide then now() else null end
     where id = p_id and (hidden_at is null) = p_hide;
    get diagnostics v_found = row_count;
  else
    -- 回文下架要同時調整該篇的 comment_count，否則列表上的數字會對不上實際看得到的則數
    update post_comments set hidden_at = case when p_hide then now() else null end
     where id = p_id and (hidden_at is null) = p_hide
     returning post_id into v_post;
    get diagnostics v_found = row_count;
    if v_found > 0 and v_post is not null then
      update posts
         set comment_count = greatest(0, comment_count + case when p_hide then -1 else 1 end)
       where id = v_post;
    end if;
  end if;

  -- 這一則的所有待處理檢舉一起結案：下架＝成立，回復＝駁回。
  -- 不結的話，同一則會在待處理清單裡一直出現，而觀主已經處理過了。
  update reports
     set status = case when p_hide then 'actioned' else 'dismissed' end,
         handled_at = now(), handled_by = p_admin
   where target_type = p_type and target_id = p_id and status = 'open';

  return jsonb_build_object('ok', v_found > 0, 'changed', v_found);
end $$;

comment on function moderate_target is
  '下架／回復一則貼文或回文，連帶調整 comment_count 並結掉該則的待處理檢舉。';

-- 0044 之後的 function 已由全域 default privileges 收好；照 0043／0056 的做法再收一次，
-- 不依賴執行順序——這一支能把任何內容下架。
revoke all on function moderate_target(text, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function moderate_target(text, uuid, boolean, uuid) to service_role;

-- ── 六、目標消失時，檢舉也要跟著走
--
-- reports.target_id 是多型的（同一欄可能指向 posts 或 post_comments），所以它
-- 沒有辦法掛外鍵，也就享受不到 cascade。後果是：貼文被刪掉（作者自刪、帳號刪除、
-- 觀主刪文）之後，指著它的檢舉會留在待處理清單裡，點開是一則不存在的東西。
--
-- 用 trigger 而不是在各個刪除路徑各寫一次：刪除的入口有四五個（0056 的
-- delete_account、廣場的自刪、ADMIN_USER_ID 刪文、posts 的 cascade），
-- 每個都補一行，往後多一個入口就會漏一次，而漏掉只會安靜地累積垃圾。
create or replace function reports_cleanup() returns trigger
language plpgsql
as $$
begin
  delete from reports
   where target_id = old.id
     and target_type = case tg_table_name when 'posts' then 'post' else 'comment' end;
  return old;
end $$;

drop trigger if exists posts_reports_cleanup on posts;
create trigger posts_reports_cleanup after delete on posts
  for each row execute function reports_cleanup();

drop trigger if exists post_comments_reports_cleanup on post_comments;
create trigger post_comments_reports_cleanup after delete on post_comments
  for each row execute function reports_cleanup();

revoke all on function reports_cleanup() from public, anon, authenticated;
grant execute on function reports_cleanup() to service_role;

-- 【這一類要特別處理】reason = 'selfharm'
--
-- 檢舉自傷／輕生內容，與檢舉廣告不是同一件事：前者有一個真的人在那則貼文後面。
-- 端點會把這一類的推播另外標記（見 interpret 的 report_create），讓它在一堆
-- 廣告檢舉裡不會被滑過去。
--
-- 但下架本身不是處置——把貼文藏起來，那個人還在。這一層目前只做到「讓觀主
-- 看得見、而且看得出輕重」，實際要怎麼接觸到那個人，是產品要想的事，不是 SQL。

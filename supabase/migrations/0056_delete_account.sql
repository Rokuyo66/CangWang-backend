-- 0056_delete_account.sql — 帳號刪除
--
-- 個資法與雙平台商店都要求「使用者能自己把帳號刪掉」，而目前全站沒有任何一條
-- 刪除路徑。這支補上那條路。
--
-- 【為什麼是一支 SQL function，不是二十次 delete】
--
-- 一、原子性。刪到一半的帳號比沒刪更糟：卦刪了、靈石流水還在，那個人既登不回來
--     也沒被刪乾淨，而且沒有任何地方看得出他卡在哪一步。function 跑在單一交易裡，
--     要嘛全成、要嘛全不動。
-- 二、順序只寫一次。下面第三段會看到，這張圖的順序不是自明的——散在 TypeScript 裡
--     的二十行 delete，往後加一張表就會漏一次，而漏掉不會報錯。
--
-- 【順帶修掉一個線上 bug：plaza_notices 的外鍵指錯了】
--
-- 0029 把 plaza_notices.user_id 的外鍵指向 auth.users(id)，但全站寫進這個欄位的
-- 一直是 profiles.id（interpret/index.ts 那一行取的是 post_comments.user_id）。
-- 兩個 id 空間不同，所以那個 insert 從來沒成功過——而它沒有檢查回傳的 error，
-- 於是「有人回你的文」這個紅點從上線到現在一次都沒亮過，也一次都沒報錯。
-- TG 用戶更是連 auth.users 那一列都沒有，這條路本來就走不通。
--
-- 這件事本來不歸這支管，但刪除必須知道 plaza_notices 是哪一個 id 空間才寫得對，
-- 所以順手修在這裡：外鍵改指 profiles(id)，並先清掉對不上的孤兒列（照推論應該是
-- 零列，但不假設）。

-- ── 一、plaza_notices 外鍵改指 profiles
delete from plaza_notices n where not exists (select 1 from profiles p where p.id = n.user_id);

alter table plaza_notices drop constraint if exists plaza_notices_user_id_fkey;
alter table plaza_notices
  add constraint plaza_notices_user_id_fkey
  foreign key (user_id) references profiles(id) on delete cascade;

comment on column plaza_notices.user_id is
  '收到通知的人＝profiles.id（0056 改；0029 原本指向 auth.users，與全站寫入的 id 空間不符）';

-- ── 二、刪除
--
-- 【這張圖為什麼要按順序】
--
-- 大部分表是 on delete cascade，刪掉 profiles 那一列就一起走了。但有三類不是：
--
--   (1) RESTRICT（建表時沒寫 on delete）：casts、feedback、ledger。
--       這三張會讓 `delete from profiles` 直接失敗——也就是說在這支之前，
--       任何起過一卦的帳號都刪不掉。必須先手動刪，順序也不能反。
--   (2) 根本沒有外鍵：ai_usage、cast_claims、rate_minute。刪 profiles 不會動到它們，
--       留著就是一堆掛著已刪帳號 uuid 的孤兒列。
--   (3) 不是用 user_id 關聯的：free_quota（key 是字串拼出來的）、
--       tg_sessions（主鍵是 tg_id）。這兩張只能靠比對字串找，而 tg_id 必須在
--       identities 被 cascade 掉之前先抓出來——順序反了就再也找不到。
--
-- 【刻意留下的兩樣】
--
--   ai_usage：不刪，改成把 user_id 設為 null。那張表是成本核算的真相來源
--             （0043 的 ai_cost() 全建在它上面），刪掉等於讓歷史成本報表出現
--             無法解釋的凹陷。去掉 user_id 之後剩下的是 mode／model／token 數，
--             不含任何個資，留著只會讓帳算得準。
--   daily_stats：本來就沒有 user_id，是彙總值，不動。
--
-- ledger 沒有這個待遇：它的 user_id 是 not null，補不了 null，只能刪。
-- ⚠ 等金流接上之後，購買紀錄會有稅務保存義務，屆時這一段要改成「另存一份
--   去識別化的交易紀錄」再刪，不能照現在這樣直接刪掉。
create or replace function delete_account(p_user uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_tg_ids   text[];
  v_auth_ids text[];
  v_casts    int;
  v_posts    int;
begin
  if p_user is null then
    raise exception 'DELETE_ACCOUNT_NO_USER';
  end if;
  if not exists (select 1 from profiles where id = p_user) then
    raise exception 'DELETE_ACCOUNT_NOT_FOUND';
  end if;

  -- 0. 先把「刪完就再也查不到」的外部識別抓出來。
  --    identities 是 cascade 的，profiles 一刪它就沒了，屆時無從得知這人的 tg_id
  --    是多少，tg_sessions 會永遠留一列。呼叫端也要靠 auth_ids 去刪 auth.users。
  select coalesce(array_agg(external_id) filter (where provider = 'tg'), '{}'),
         coalesce(array_agg(external_id) filter (where provider = 'web'), '{}')
    into v_tg_ids, v_auth_ids
    from identities where user_id = p_user;

  select count(*) into v_casts from casts where user_id = p_user;
  select count(*) into v_posts from posts where user_id = p_user;

  -- 1. 反計數：他按過的讚、他留在別人文章下的回文，都要把對方的計數扣回去。
  --    這兩個數字是反正規化的欄位，cascade 只會把關聯列刪掉、不會動計數——
  --    不扣的話，別人的文章會永遠掛著一個對不上實際列數的讚數與回文數。
  update posts p set like_count = greatest(0, p.like_count - 1)
    from post_likes l where l.post_id = p.id and l.user_id = p_user;

  update post_comments c set like_count = greatest(0, c.like_count - 1)
    from post_comment_likes l where l.comment_id = c.id and l.user_id = p_user;

  update posts p set comment_count = greatest(0, p.comment_count - x.n)
    from (select post_id, count(*) n from post_comments
           where user_id = p_user group by post_id) x
   where p.id = x.post_id;

  -- 2. 沒有外鍵的三張：cascade 碰不到，得自己來
  update ai_usage set user_id = null where user_id = p_user;   -- 去識別化，不刪（理由見上）
  delete from cast_claims where user_id = p_user;
  delete from rate_minute  where user_id = p_user;

  -- 3. free_quota：key 是字串拼出來的，只能比對。
  --    網頁起卦的額度鍵就是 uid 本身；其餘是 <前綴>:<uid>:<日期>
  --    （chatfree／commentfree／followfree／postfree／probefree／refine）；
  --    TG 起卦的是 tg:<tg_id>。
  delete from free_quota
   where key = p_user::text
      or key like '%:' || p_user::text || ':%'
      or key in (select 'tg:' || t from unnest(v_tg_ids) t);

  -- 4. tg_sessions：主鍵是 tg_id，與 profiles 之間沒有外鍵
  if array_length(v_tg_ids, 1) is not null then
    delete from tg_sessions where tg_id = any (v_tg_ids);
  end if;

  -- 5. 三張 RESTRICT。順序不能反：
  --    feedback 先於 casts（feedback.user_id 擋著 profiles，且它自己 cascade 於 casts，
  --    但仍可能有指向他人卦的列，故照 user_id 明確刪一次）；
  --    casts 一刪，followups 與其餘 feedback 隨之 cascade。
  delete from feedback where user_id = p_user;
  delete from casts    where user_id = p_user;
  delete from ledger   where user_id = p_user;

  -- 6. 本體。其餘十九張表由 on delete cascade 一併帶走：
  --    identities、user_character、user_character_events、chat_messages、
  --    character_memories、reminders、threads、thread_notes、monthly_reviews、
  --    owned_packs、placed_stickers、voice_clips、gua_collection、case_runs、
  --    tts_usage、posts（→post_comments→post_comment_likes→plaza_notices）、
  --    post_likes、post_comment_likes、plaza_notices
  delete from profiles where id = p_user;

  return jsonb_build_object(
    'deleted', true,
    'casts',   v_casts,
    'posts',   v_posts,
    'tg_ids',   to_jsonb(v_tg_ids),
    'auth_ids', to_jsonb(v_auth_ids)   -- 呼叫端據此刪 auth.users（SQL 這一層動不了）
  );
end $$;

comment on function delete_account is
  '刪除一個帳號的全部資料，單一交易。回傳的 auth_ids 仍須由呼叫端以 Admin API 刪除 auth.users。';

-- ⚠ voice_clips 只是指標，不必刪檔案：音檔放在全站共用的 tts bucket，
--   檔名是「模型＋聲線＋逐字文本」的 SHA-256，同一段話所有人共用同一個檔
--   （見 _shared/voice.ts 與 dev/deploy-howto.md 第 2 步）。刪掉那個檔會把
--   別人的收藏一起弄啞，而它本身不含任何可指向個人的資訊。

-- 0044 之後新增的 function 已由全域 default privileges 收好權；這裡照 0043 的做法
-- 自己再收一次，不依賴執行順序。這一支能刪掉任何一個帳號，是全站最該收緊的一支。
revoke all on function delete_account(uuid) from public, anon, authenticated;
grant execute on function delete_account(uuid) to service_role;

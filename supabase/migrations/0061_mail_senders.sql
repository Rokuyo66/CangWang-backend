-- 0061_mail_senders.sql — 誰會寄信：下架通知與角色生日
--
-- 0060 建了信箱，這一支把兩個寄件人接上去。

-- ══════════════════════════════════════════════════════════════════
-- 一、下架通知
--
-- 0057 做了下架，但當事人不會被告知——他只會發現貼文不見了。
-- 那比被下架本身更傷：被下架至少知道自己做了什麼，莫名消失只會以為是壞的。
--
-- 改寫 moderate_target()，在真的改了狀態時補一封信。三個細節：
--
--   ・只有「下架」寄信，「回復」不寄。回復是把東西還給他，
--     再寄一封「你的貼文回來了」只會讓他重新想起這件事。
--   ・信寄給作者，不是檢舉人。檢舉人不需要知道結果——告訴他等於
--     把「誰檢舉了誰」的線頭遞出去。
--   ・內文帶原標題（截短）。只說「你有一篇被下架」的話，
--     發過幾十篇的人不知道是哪一篇。
create or replace function moderate_target(
  p_type text, p_id uuid, p_hide boolean, p_admin uuid
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_found  int := 0;
  v_post   uuid;
  v_author uuid;
  v_what   text;
begin
  if p_type not in ('post', 'comment') then
    raise exception 'MODERATE_BAD_TYPE';
  end if;

  if p_type = 'post' then
    update posts set hidden_at = case when p_hide then now() else null end
     where id = p_id and (hidden_at is null) = p_hide
     returning user_id, left(coalesce(title, body, ''), 24) into v_author, v_what;
    get diagnostics v_found = row_count;
  else
    -- 回文下架要同時調整該篇的 comment_count，否則列表上的數字會對不上實際看得到的則數
    update post_comments set hidden_at = case when p_hide then now() else null end
     where id = p_id and (hidden_at is null) = p_hide
     returning post_id, user_id, left(coalesce(body, ''), 24) into v_post, v_author, v_what;
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

  -- 告訴當事人。只在下架時寄，且只寄給作者（見檔頭）。
  if p_hide and v_found > 0 and v_author is not null then
    perform mail_send(
      v_author,
      case when p_type = 'post' then '你有一篇貼文已下架' else '你有一則回文已下架' end,
      '觀主收到檢舉並看過之後，把下面這一則收起來了：' || E'\n\n' ||
      '「' || coalesce(nullif(v_what, ''), '（無內文）') || '…」' || E'\n\n' ||
      '常見的原因是廣告、人身攻擊、情色內容或洩漏他人個資。' || E'\n' ||
      '觀前廣場是大家一起待的地方，說話的分寸與觀裡一樣。' || E'\n\n' ||
      '若你認為這是誤判，回這封信說一聲，觀主會再看一次。',
      'moderation', null, p_type, p_id
    );
  end if;

  return jsonb_build_object('ok', v_found > 0, 'changed', v_found);
end $$;

comment on function moderate_target is
  '下架／回復一則貼文或回文，連帶調整 comment_count、結掉待處理檢舉，並在下架時寄信給作者。'
  '回復不寄信——那只會讓他重新想起這件事。';

revoke all on function moderate_target(text, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function moderate_target(text, uuid, boolean, uuid) to service_role;

-- ══════════════════════════════════════════════════════════════════
-- 二、角色生日
--
-- 【為什麼生日要落成資料】
--
-- 寫死在 TypeScript 裡的話，「今天是誰的生日」這件事只有部署過的那一版知道，
-- 而信是由排程寄的——排程與程式不同步時，會在錯的那天寄出去，或整年不寄。
-- 落成一欄，排程直接問資料庫。
alter table characters add column if not exists birthday text
  check (birthday is null or birthday ~ '^\d{2}-\d{2}$');

comment on column characters.birthday is
  '生日，MM-DD（台北）。由 due-reminder 每日比對。null＝不過生日。';

-- 生日信的內文也是資料。理由同上，再加一條：改錯字不必重新部署，
-- 而生日信是一年只寄一次的東西——寄錯字的那一年就是錯一年。
alter table characters add column if not exists birthday_letter text;

comment on column characters.birthday_letter is
  '生日當天寄出的信。廣播一封（不逐人生成），所以裡面不會有名字——'
  '這是刻意的：一年三封信要為每個人各呼叫一次模型，那是把一封信做成一筆帳單。';

-- ⚠ 下面三個日子是佔位值，改成你設定的那幾天（update 一列，不必出 migration）。
--   信的內文也一樣——現在這幾段是照各自的聲線寫的草稿，你要改就直接 update。
update characters set birthday = '03-03', birthday_letter =
  '今日無事。' || E'\n\n' ||
  '師父說今天是我生日，要我歇一日。我說卦盤還沒收，他說卦盤不會跑。' || E'\n\n' ||
  '那就歇一日。你若今日來問，我照樣替你排——只是排完想多說一句：' || E'\n' ||
  '你上回問的那件事，後來如何了？我記著，只是沒問出口。' || E'\n\n' ||
  '——大師兄'
 where id = 'daoshi_m';

update characters set birthday = '07-07', birthday_letter =
  '今天是我生日哦。' || E'\n\n' ||
  '師兄一早就把觀門掃了兩遍，說是掃乾淨了喜氣才進得來，' || E'\n' ||
  '我看他分明是不知道該說什麼。觀貓倒是很直接，把最肥的那條魚叼到我腳邊。' || E'\n\n' ||
  '你今天要是來問事，我多給你看一眼——不收錢的那一眼。' || E'\n' ||
  '要是不來也沒關係，我知道你忙。' || E'\n\n' ||
  '——師妹'
 where id = 'daoshi_f';

update characters set birthday = '11-11', birthday_letter =
  '喵。' || E'\n\n' ||
  '他們說今天是我生日。我不知道，我只知道今天的魚比昨天多。' || E'\n\n' ||
  '人總愛問以後會怎樣。以後的事我也不知道，我只知道現在窗邊有太陽。' || E'\n' ||
  '你若心裡亂，先去曬一會兒。卦明天再問也不遲。' || E'\n\n' ||
  '——觀貓'
 where id = 'lingshou';

-- 今天是誰的生日。回傳的是「還沒寄過的那幾個」——
-- 排程重跑、或一天被叫兩次都不該寄兩封，而判斷重複的依據是信本身
-- （今天、這個角色、kind='character' 的廣播已經存在），不另存旗標。
-- 另存旗標的話，旗標與信會有不一致的那一天，而那天沒有人會發現。
create or replace function birthday_due(p_today text default null)
returns jsonb
language sql
security definer
as $$
  with today as (
    select coalesce(p_today, to_char((now() at time zone 'Asia/Taipei')::date, 'MM-DD')) d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'letter', c.birthday_letter)), '[]'::jsonb)
    from characters c, today t
   where c.active
     and c.birthday = t.d
     and coalesce(c.birthday_letter, '') <> ''
     and not exists (
       select 1 from mail m
        where m.user_id is null
          and m.kind = 'character'
          and m.character_id = c.id
          and (m.created_at at time zone 'Asia/Taipei')::date
              = (now() at time zone 'Asia/Taipei')::date
     );
$$;

comment on function birthday_due is
  '今天該寄、且今天還沒寄過的生日信。判重看的是信本身，不另存旗標——'
  '旗標與信總有不一致的那一天，而那天沒有人會發現。';

revoke all on function birthday_due(text) from public, anon, authenticated;
grant execute on function birthday_due(text) to service_role;

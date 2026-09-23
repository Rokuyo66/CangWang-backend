-- 0064_mail_midautumn_2026.sql — 2026 中秋，師妹的信（附 30 靈石）
--
-- 一次性寄出。要先跑 0063（信裡才夾得了靈石）。
--
-- 廣播照 0060 的規則：收得到的是「寄出這一刻已經註冊」的人。
-- 判重用標題＋寄件人＋年份：這支重跑（migrate.ps1 的保險重跑、或手滑）不會寄第二封。
--
-- 往後的節慶信、更新信不必再寫 migration：Telegram 打
--   /mail 標題｜內文｜靈石數
-- 就是同一件事（見 webhook-tg 的 /mail）。這一封寫成檔，是因為它與 0063 同一次上線。

do $$
declare v_subject constant text := '中秋，替你留了一份';
begin
  if exists (
    select 1 from mail
     where user_id is null and character_id = 'daoshi_f' and subject = v_subject
       and created_at >= '2026-01-01'
  ) then
    raise notice '中秋信已經寄過，略過';
    return;
  end if;

  perform mail_send(
    null,
    v_subject,
    '施主：' || E'\n\n' ||
    '中秋要到了。' || E'\n' ||
    '＊師妹把帳簿合上，壓在一盒月餅底下＊' || E'\n\n' ||
    '觀裡今年的月餅是山下老鋪做的，蓮蓉和棗泥各一盒，前廳替你留了一份。' || E'\n' ||
    '可你大概拿不走——所以換成三十顆靈石，夾在這封信裡。' || E'\n\n' ||
    '師兄說，中秋不過是月亮圓一點。' || E'\n' ||
    '貓倒是很當一回事，一整晚蹲在屋脊上，沒下來。' || E'\n\n' ||
    '不管今晚是和誰一起看月亮，還是自己一個人，記得吃點好的。' || E'\n' ||
    '有什麼想說的，前廳的燈會一直亮著。' || E'\n\n' ||
    '中秋愉快。' || E'\n' ||
    '——師妹',
    'character', 'daoshi_f', null, null, 30
  );
end $$;

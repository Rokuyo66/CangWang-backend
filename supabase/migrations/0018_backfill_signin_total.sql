-- 0018_backfill_signin_total.sql
-- 回填累計簽到數 signin_total（頭像 a~h 解鎖依據）。
-- 兩個歷史缺口：① TG BOT 簽到一直沒累加 signin_total（已修 webhook-tg）
-- ② 0015 加欄位以前的簽到本就沒計入。
-- 以「目前連續天數 sign_streak」回填下限：連續 N 天至少簽過 N 次。冪等、只增不減。

update profiles
set signin_total = greatest(signin_total, sign_streak)
where sign_streak > signin_total;

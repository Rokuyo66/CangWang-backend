-- 0052_guide_seen_backfill.sql — 已經問過卦的帳號，不該再被當成第一次登入
--
-- 0031 加了 guide_seen_at，記號由前端關掉引導那一刻打回來蓋上。那一趟只要漏掉一次
-- （斷網、token 正在刷新、後端還沒部署到有 set_guide_seen 的版本），記號就永遠是 null，
-- 而 profile 只認這一個欄位——於是每次登入都再講一次那七句規矩，且不會自己好。
--
-- 這一支把已經有卦的帳號補起來：問過卦的人不可能還停在第一次登入。
-- 時間用他自己第一卦的時間，不用 now()——記號的用途是「上次看引導是什麼時候」，
-- 蓋成執行 migration 的當下，日後「引導改版就依時間再放一次」會把這批人整批漏掉。

update profiles p
   set guide_seen_at = c.first_cast
  from (select user_id, min(created_at) as first_cast from casts group by user_id) c
 where c.user_id = p.id
   and p.guide_seen_at is null;

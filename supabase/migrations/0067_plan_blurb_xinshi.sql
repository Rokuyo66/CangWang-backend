-- 0067_plan_blurb_xinshi.sql — 知幾的 blurb 用字：「心跡同時記八件事」→「心事同時記八件」
--
-- 心跡是整個功能（手帳那一層），心事是其中的一件事（手帳›心事 那一格的單位）。
-- 「同時記幾件」數的是心事，不是心跡。數字 8 本身沒錯（xinji.ts PLAN_THREADS.zhiji）。
--
-- 0058 的 insert 是 on conflict do nothing，改那裡不會生效，所以用 update。

update plans set blurb = '每日五卦五追問，心事同時記八件' where id = 'zhiji';

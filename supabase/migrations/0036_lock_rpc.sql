-- 關掉 PostgREST 對 public schema function 的對外呼叫權。
--
-- 洞在哪：apply_lingshi 是 security definer，而 PostgreSQL 對 function 的 EXECUTE
-- 預設就 grant 給 PUBLIC，Supabase 又把 public schema 的 function 全開在
-- /rest/v1/rpc/<name>。前端那把 anon key 是公開的（本來就該公開），於是任何人都能：
--
--   POST /rest/v1/rpc/apply_lingshi  {"p_user":"<uid>","p_action":"x","p_amount":99999999}
--
-- security definer 以 owner 身分執行，直接繞過 RLS——所有表鎖得再緊都攔不到，
-- 因為根本沒經過 RLS。uid 也不必猜，profile 那支 API 自己就回傳了。
--
-- 同一條路還能走的：bump_post_like / bump_comment_like 把自己貼文的讚灌過熱門門檻
-- 去領靈石獎勵（就算堵了 apply_lingshi 也還能間接印錢）、admin_stats() 讀走營運數據、
-- cleanup_expired_casts() 被任何人觸發去刪資料。
--
-- 為什麼可以整片鎖而不必逐支挑：前端只用 supabase-js 做「登入」，其餘一律走
-- interpret Edge Function（service role）。全庫搜過 sb.from / sb.rpc / /rest/v1，
-- 前端零命中——PostgREST 這個入口根本沒人在用，關掉不影響任何現有功能。

revoke execute on all functions in schema public from public, anon, authenticated;

-- service role 是 Edge Function 的身分，上面那行連帶收掉了它經由 PUBLIC 繼承來的權限，
-- 得明確補回去，否則所有 db.rpc(...) 會全部失效。
grant execute on all functions in schema public to service_role;

-- 關鍵的一行：往後新增的 function 自動是鎖的。
-- 少了它，下一支 security definer function 又會帶著預設的 PUBLIC 權限誕生，
-- 而這種洞不會有任何徵兆——功能一切正常，只是同時對外開著。
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public grant  execute on functions to service_role;

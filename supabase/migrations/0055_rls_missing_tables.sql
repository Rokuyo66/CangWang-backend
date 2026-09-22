-- 0055_rls_missing_tables.sql — 六張表從出生起就沒鎖過
--
-- 0001 檔尾寫下了這個專案的安全模型，一句話：
--
--   「RLS：MVP 階段所有存取都經 service role（Edge Function），先全鎖」
--
-- 底下跟著九行 enable row level security，沒有一條 policy。這個組合是刻意的，
-- 而且是對的：RLS 開著、policy 一條都沒有 ＝ anon 與 authenticated 一律拒絕，
-- 而 service_role 本來就繞過 RLS。Edge Function 拿的是 service role key，
-- 所以功能不受影響，外面則完全進不來。
--
-- 之後 25 支 migration 大致照著做了，但有六張表漏掉——沒有任何徵兆，
-- 功能一切正常。這是 0044 檔頭那句話的翻版，只是這次漏的是 table 不是 function：
--
--   characters            角色人設 prompt
--   case_runs             卦案存檔
--   cast_claims           起卦冪等憑據
--   character_events      角色事件劇本
--   user_character_events 每人的事件進度
--   daily_stats           全站營運數據
--
-- 【為什麼「沒開 RLS」等於「全開」】
--
-- Supabase 在 public schema 上設了 default privileges，新建的 table 會自動
-- grant ALL 給 anon 與 authenticated。這兩個角色對應的就是那把印在前端裡的
-- 公開 anon key。所以一張沒開 RLS 的表，等於在 /rest/v1/<table> 上開了一個
-- 任何人都能 select／insert／update／delete 的端點。
--
-- 0036 與 0044 很仔細地把 function 那條線收乾淨了，0043 連 view 的
-- security_invoker 都想到了。table 這條線一直是靠「每支 migration 自己記得寫」
-- 在維持的——六次漏寫就是這樣來的。
--
-- 【實際能做到什麼】依嚴重度：
--
-- 一、characters.persona_prompt 可被讀走，而且可被 UPDATE。
--     讀走是 IP 外洩；改掉是把任意文字寫進每位用戶的每一次 AI 呼叫的 system——
--     這比外洩嚴重得多，而且不會有任何錯誤日誌，只會是「角色最近怪怪的」。
--
-- 二、case_runs.state 可被客戶端直接改寫。0039 檔頭立的鐵則是
--     「進度與獎勵一律服務端判定，客戶端只送我做了什麼」——繞過整張表就繞過了鐵則。
--
-- 三、cast_claims 可被刪。0035 整支的意義是起卦冪等；token 被刪掉，
--     同一次起卦就能重複成立，重複扣費、重複呼叫 AI。
--
-- 四、character_events / user_character_events 可被讀走（未上線的劇本內容）
--     與改寫（事件進度、連帶獎勵）。
--
-- 五、daily_stats 是營運數據，本來就不該給外面看。
--
-- 【上線前的驗收】下面這一句應該回 0 列。新增 table 之後值得順手跑一次：
--
--   select c.relname
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
--
-- 別改成查 pg_policies 有沒有列——這個專案的正確狀態就是「RLS 開著、零 policy」，
-- 照 policy 數量判斷會把每一張鎖好的表都報成洞，然後你就會開始忽略這份報告。

-- ── 一、把六張補上
--
-- 全部六張的所有存取都在 Edge Function 內、走 service role（四支 function 的
-- createClient 都吃 SUPABASE_SERVICE_ROLE_KEY），所以開 RLS 不影響任何既有路徑。
-- ⚠ 唯一要先確認的是前端：若 CangWang-web 有任何一處拿 anon key 直接讀
--   /rest/v1/characters（例如撈角色名字或頭像），那條路會在這支套用後斷掉，
--   要先改成走 interpret 的端點。其餘五張前端沒有理由直接碰。
alter table characters            enable row level security;
alter table case_runs             enable row level security;
alter table cast_claims           enable row level security;
alter table character_events      enable row level security;
alter table user_character_events enable row level security;
alter table daily_stats           enable row level security;

-- ── 二、管住未來
--
-- 補完這六張只是把帳結平，下一張新表照樣會是開的。這裡照 0044 的做法把
-- default privileges 收掉——**不帶 `in schema public`**，理由與 0044 檔頭相同：
-- 帶 schema 限定的 default privileges 是疊加在內建預設之上，拿不掉內建那份。
--
-- 這兩行只影響「往後才建立的」table，不動現有的任何一張，所以沒有回頭破壞的風險。
-- 它不是 RLS 的替代品（service_role 之外的角色仍該被 RLS 擋），而是第二道：
-- 下次再漏寫 enable row level security 時，那張表至少不會連 grant 都是全開的。
alter default privileges revoke all on tables from public, anon, authenticated;
alter default privileges grant  all on tables to service_role;

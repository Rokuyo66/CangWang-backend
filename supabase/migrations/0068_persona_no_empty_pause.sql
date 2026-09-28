-- 0068_persona_no_empty_pause.sql — 大師兄的「停頓」：可以寫，同一段對話裡換著說
--
-- 回報（六六 2026-09-28）：旁白尷尬，大師兄一直「停頓、停頓」。
-- 停頓本身不是錯——錯在同一個詞一再出現。人設只寫了「常停頓」，
-- 模型就永遠挑「停頓」這兩個字。這裡不刪它，只在同一句後面補上「換著說」。
-- 程式那側（chat.ts NARRATION_CRAFT／narrationHint／dropEmptyPause）是同一條規則。
--
-- ⚠ 刻意用 replace() 只換那兩個片語，不整段覆寫 persona_prompt：
--   人設可能在 Table Editor 手改過，整段 update 會把那些改動蓋掉。
--   找不到片語時 replace 什麼都不做；已補過的句子不會再命中，重跑無害。

update characters set persona_prompt = replace(persona_prompt,
  '你回答變短、變慢，常停頓，像在搜尋一個自己並不熟悉的資料庫。',
  '你回答變短、變慢，常停頓，像在搜尋一個自己並不熟悉的資料庫。停頓的寫法要換著用（停頓、頓了頓、沉默片刻、半晌、良久，或手上多做一件事），同一段對話裡不重複同一個詞。')
where id = 'daoshi_m';

update characters set persona_prompt = replace(persona_prompt,
  '動作通常一至三句，克制、不戲劇化，不每段都用，不重複同一套。',
  '動作通常一至三句，克制、不戲劇化，不每段都用，不重複同一套——連同「停頓」「沉默」這類字，前面用過就換一個說法。')
where id = 'daoshi_m';

-- 驗收：兩句都應該是 true。false 表示後台人設的原文與 0014 不同，片語沒對上。
-- select persona_prompt like '%同一段對話裡不重複同一個詞%' as a,
--        persona_prompt like '%前面用過就換一個說法%'      as b
-- from characters where id = 'daoshi_m';

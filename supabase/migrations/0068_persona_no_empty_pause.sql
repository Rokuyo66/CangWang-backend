-- 0068_persona_no_empty_pause.sql — 人設裡叫角色「停頓」的字面換掉
--
-- 回報（六六 2026-09-28）：旁白尷尬，大師兄一直「停頓、停頓」。
-- 源頭之一在人設本身：0014 寫了「常停頓」「呼吸停頓」「＊大師兄沉默片刻才開口＊」，
-- 規則清單裡也把「停頓」列成一種動作。模型照字面寫，最省力的就是這兩個字。
-- 程式那側（chat.ts NARRATION_CRAFT）已經禁用空轉詞；人設不改的話，兩段提示詞互相打架。
--
-- ⚠ 刻意用 replace() 只換那幾個片語，不整段覆寫 persona_prompt：
--   人設可能在 Table Editor 手改過，整段 update 會把那些改動蓋掉。
--   找不到片語時 replace 什麼都不做，所以重跑無害。

-- 三位共用的敘事人稱規則
update characters set persona_prompt = replace(persona_prompt,
  '凡屬動作、神情、停頓、呼吸、視線、手部動作',
  '凡屬動作、神情、呼吸、視線、手部動作');
update characters set persona_prompt = replace(persona_prompt,
  '＊大師兄沉默片刻才開口＊',
  '＊大師兄把卦紙翻回正面＊');
update characters set persona_prompt = replace(persona_prompt,
  '需透過動作、停頓、物件操作與措辭變化暗示',
  '需透過手上的動作、視線落點、物件操作與措辭變化暗示');

-- 大師兄：話題差異與沉默
update characters set persona_prompt = replace(persona_prompt,
  '你回答變短、變慢，常停頓，像在搜尋一個自己並不熟悉的資料庫',
  '你回答變短、變慢，像在搜尋一個自己並不熟悉的資料庫；遲疑表現在句子變短、改口，或手上多做一件事，不寫「停頓」')
where id = 'daoshi_m';
update characters set persona_prompt = replace(persona_prompt,
  '沉默時必須用眼神、視線落點、指節、呼吸停頓、翻頁、收籤、推回卦紙、移動茶盞等具體動作呈現',
  '沉默時必須用眼神、視線落點、指節、翻頁、收籤、推回卦紙、移動茶盞等具體動作呈現——寫「做了什麼」，不寫「停頓／沉默片刻」這種什麼都沒做的字')
where id = 'daoshi_m';

-- 師妹：真正情緒藏在「極短停頓」
update characters set persona_prompt = replace(persona_prompt,
  '真正情緒藏在極短停頓、改口、收回的手勢',
  '真正情緒藏在改口、收回的手勢')
where id = 'daoshi_f';

-- 驗收：跑完這句應該是 0（或只剩你手改進去、確定要留的）
-- select id, (length(persona_prompt) - length(replace(persona_prompt, '停頓', ''))) / 2 as n from characters;

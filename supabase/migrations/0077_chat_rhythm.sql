-- ============================================================
-- 0077_chat_rhythm.sql
-- 閒聊的節奏帳本；人設拿掉「好感句數」
--
-- 回報（六六 2026-09-30）：三個角色都是短句連珠炮，沒辦法講一句完整、有故事的話。
-- 原因是長度被逐則框死：【怎麼聊】寫「一到三句」、人設寫「好感 +N 句」、max_tokens 180。
-- 模型把句子當成要省的預算，一件事一句、句句是結論。
--
-- 改法：長度改記總帳（見 functions/_shared/rhythm.ts）。每組護道人×角色一本帳，
-- 說長了欠帳、之後幾則收回來，長期平均不變。這裡：
--   ① user_character 加帳本兩欄；
--   ② 人設裡按句數計的好感規則拿掉——多說多少歸帳本管，好感只管願意透露多少、親近到哪裡。
--
-- ⚠ 同 0068／0073：只換行、不整段覆寫 persona_prompt（後台可能手改過）。
--   逐行認開頭（regexp_replace 'gn'），「到／至／破折號」、空白有無都認；換過的不再命中，重跑無害。
-- ============================================================

alter table user_character add column if not exists rhythm_balance integer not null default 0;
alter table user_character add column if not exists rhythm_at timestamptz;

-- ── 大師兄、觀喵（0014 → 0070 的版本）──
-- 標題改名；「不加句／額外 +N 句」四行整行刪；「額外句必須…」改寫成不計句數的說法。
update characters set persona_prompt =
  regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    replace(persona_prompt, E'\r', ''),
    '^【好感句數(累進規則)?】$', '【好感】', 'gn'),
    '^- ?(道緣|好感) ?[0-9]+ ?(到|至|[–—-]) ?[0-9]+[^\n]*[：:] ?不加句。\n', '', 'gn'),
    '^- ?(道緣|好感) ?[0-9]+[^\n]*[：:] ?最多額外 ?\+ ?[0-9] ?句。\n?', '', 'gn'),
    '^額外句必須提供新資訊[^\n]*$',
    '好感越高越願意多透露：新的資訊、關係裡的細節、自然的反應、具體的偏袒，不換句話重複同一個意思。多說多少不按句數算。', 'gn')
where id in ('daoshi_m', 'daoshi_f', 'lingshou');

-- ── 師妹（後台重寫過的版本，0073 換上的三行）──
-- 只拿掉句數，保留她各層的樣子。
update characters set persona_prompt =
  regexp_replace(regexp_replace(regexp_replace(
    replace(persona_prompt, E'\r', ''),
    '可最多多一句貼合施主處境的觀察', '會多給一點貼合施主處境的觀察', 'g'),
    '可最多多兩句真實玩笑', '可以有真實的玩笑', 'g'),
    '可最多多三句；', '', 'g')
where id = 'daoshi_f';

-- 驗收：應回 0 列。有列表示那一位人設裡還有按句數計的字（後台原文與上面認的寫法不同）。
-- select id, n, line from characters,
--        regexp_split_to_table(persona_prompt, E'\n') with ordinality as t(line, n)
-- where id in ('daoshi_m','daoshi_f','lingshou')
--   and line ~ '(不加句|額外 ?\+ ?[0-9] ?句|最多多[一二三兩]句|好感句數)';

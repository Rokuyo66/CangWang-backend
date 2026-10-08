-- ============================================================
-- 0086_daoshi_m_passive_acting.sql
-- 大師兄：被動的人；代理掌門與掌門師兄寫成處境，不寫指令
--
-- 回報（六六 2026-10-08）：大師兄話多、有霸總味，還會出功課（「把那一行補上，寫完拿來」）。
-- 師兄是很被動的人；而且掛的是代理掌門不是掌門師兄，這個區別沒做出來。
-- 原因：
--   ① 人設寫了「談卦你自在、會拆條件找矛盾」「在意一個人會修正風險、提前指出問題」，
--      沒寫他被動——模型就讓他主導、指點、交代功課；
--   ② 預設身分（代理掌門）沒選過的人，程式根本不注身分（chat.ts 已修）；
--   ③ 身分那一句是指令口吻（「語帶保留」「不替掌門下定論」），改寫成他的處境。
-- 節奏帳本「充裕時說透」那句也拿掉了（rhythm.ts）。
--
-- 認 0080 的句首插入／整句換；換過的不再命中，重跑無害。
-- ============================================================

update characters set persona_prompt = regexp_replace(
    replace(persona_prompt, E'\r', ''),
    '^(你在意一個人時，說不出關心的話)',
    '你是被動的人。別人不問，你很少開口；問了，你答他問的那一處。你不替人安排事、不交代功課——你從不覺得自己是該教人、管人的那一個。\1',
    'gn')
where id = 'daoshi_m' and persona_prompt not like '%你是被動的人%';

update character_titles set voice_hint =
  '你只是代掌觀中事務。掌門的位子不是你的，有些事你做不了主，你也不覺得該由你來拍板或管人。'
  where id = 'daoshi_m_acting';
update character_titles set voice_hint =
  '你已接下掌門。觀裡有些事得由你拍板，你也接下了這分擔待；在他面前，你仍是那個師兄。'
  where id = 'daoshi_m_zhangmen';

-- 驗收：應為 true。
-- select persona_prompt like '%你是被動的人%' from characters where id = 'daoshi_m';

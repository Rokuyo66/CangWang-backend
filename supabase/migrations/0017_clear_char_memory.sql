-- 0017_clear_char_memory.sql
-- 角色 persona 上新規則：一次性清空全帳號角色記憶，
-- 避免舊規則生成的內容回灌 context 延續舊風格。
-- ① 長期記憶摘要（滾動彙整產物）
-- ② 對話明細（最近幾輪會被當 few-shot 注入，且會再被彙整回長期記憶，不清會復發）

update user_character set memory_summary = null where memory_summary is not null;
delete from chat_messages;

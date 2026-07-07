-- 0002_deep_reading.sql — 完整卦理快取欄位
-- 展開完整卦理時生成並存此，重複點擊直接讀快取（省成本，未來付費也只收一次）
alter table casts add column if not exists deep_reading text;

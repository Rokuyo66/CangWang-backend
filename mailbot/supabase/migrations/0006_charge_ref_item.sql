-- 0006_charge_ref_item.sql — 判斷「是不是同一筆」的證據：訂單編號、品名
--
-- 同家同金額不一定是同一筆。有編號比編號、有品名比品名；兩樣都沒有就不合併，月報標「可能重複」交給觀主。
-- 舊資料沒有這兩欄，一律落在「證據不足」那一格。冪等，可重跑。

alter table mailbot_charges add column if not exists ref text;
alter table mailbot_charges add column if not exists item text;

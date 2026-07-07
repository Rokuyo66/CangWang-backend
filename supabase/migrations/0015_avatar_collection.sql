-- 0015 頭像系統 + 斷簽補簽（最省：只加 2 欄；收集靠 casts 即時算，不建擁有表）
-- selected_avatar：玩家目前選用的頭像 key（a~h 或已解鎖獎勵 r01~r13；null=預設）
-- signin_total ：累計簽到次數（非連續，用來發 a~h：5 + min(3, floor(total/7))）
alter table profiles add column if not exists selected_avatar text;
alter table profiles add column if not exists signin_total int not null default 0;

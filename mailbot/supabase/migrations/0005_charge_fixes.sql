-- 0005_charge_fixes.sql — 帳單修正：寄件網域、排除、疑似詐騙
--
-- sender_domain：按「🚨 詐騙」時要封鎖整個網域，得知道這筆是從哪個網域寄來的
-- excluded     ：不計入月報（標成詐騙，或觀主按「✖ 不計」）
-- sus          ：抓金額時 AI 覺得像詐騙／假商店，月報上標 ❓ 提醒觀主看一眼
-- 冪等，可重跑。

alter table mailbot_charges add column if not exists sender_domain text;
alter table mailbot_charges add column if not exists excluded boolean not null default false;
alter table mailbot_charges add column if not exists sus boolean not null default false;

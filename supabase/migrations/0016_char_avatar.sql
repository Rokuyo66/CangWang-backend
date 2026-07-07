-- 0016 御三家換裝（每人各自，綁帳號）
-- user_character.avatar：該用戶對該角色選用的頭像 key（r01~r13；null=預設 AVATARS_0X_01）
alter table user_character add column if not exists avatar text;

-- 稱號：掛在暱稱下方的橫幅文字，由獎勵或付費取得。
-- 只存文字：底圖之後以固定高、可橫向拉伸的九宮格圖套用，不必逐個稱號存圖片位址。
alter table profiles add column if not exists title_tag text;

comment on column profiles.title_tag is '觀中稱號；null 時前端顯示預設「護道人」';

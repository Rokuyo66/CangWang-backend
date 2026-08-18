-- 可解鎖配色：買斷制，記在帳號。
-- 用 text[] 而非另開一張表——配色是個位數且無額外屬性，開表只是多一次 join。
alter table profiles add column if not exists owned_themes text[] not null default '{}';

comment on column profiles.owned_themes is '已解鎖的付費配色 key；宣紙與夜觀為內建不入此陣列';

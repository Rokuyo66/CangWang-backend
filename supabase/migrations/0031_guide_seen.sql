-- 初次引導：記在帳號而非裝置。
-- 存時間戳而不是布林——日後改版引導時，可依「上次看的時間早於某版」再放一次，
-- 布林就只能全部重置或全部不重置。
alter table profiles add column if not exists guide_seen_at timestamptz;

comment on column profiles.guide_seen_at is '初次問事引導看完的時間；null 表示尚未看過，登入後自動跳出一次';

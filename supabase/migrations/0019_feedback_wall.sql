-- 0019 觀前石牆：回評評語可選擇匿名公開（首頁跑馬燈）
alter table feedback add column if not exists is_public boolean not null default false;
create index if not exists feedback_public_idx on feedback (answered_at desc) where is_public;

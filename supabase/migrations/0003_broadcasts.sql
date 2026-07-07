-- ============================================================
-- 0003_broadcasts.sql
-- 觀主廣播紀錄表
-- 每一列 = 一次廣播。同時也是你「對外更新紀錄」的資料庫版本，
-- 可以跟 CHANGELOG.md 的版本號對得起來。
-- ============================================================

create table if not exists broadcasts (
  id          uuid primary key default gen_random_uuid(),
  version     text,                       -- 對應的版本號，如 'v1.4.0'（可空）
  body        text not null,              -- 廣播正文
  parse_mode  text default 'HTML',        -- 'HTML' / 'MarkdownV2' / null（純文字）
  status      text not null default 'draft',
                                          -- draft     : 已草擬、等你按確認
                                          -- pending   : 已確認、排隊中
                                          -- sending   : 發送中
                                          -- done      : 已完成
                                          -- cancelled : 你取消了
                                          -- failed    : 整批失敗
  total       int  default 0,             -- 名單總人數
  sent        int  default 0,             -- 成功送出
  failed      int  default 0,             -- 失敗（封鎖 bot、刪帳號等）
  created_by  text,                       -- 觸發者 tg_user_id（應為 ADMIN）
  created_at  timestamptz default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- 只有後端（service role）能讀寫，前端/匿名一律擋掉
alter table broadcasts enable row level security;
-- 不建任何 policy = 預設全部拒絕，只有 service_role 繞過 RLS。

-- 查詢最近廣播用的索引
create index if not exists broadcasts_created_at_idx
  on broadcasts (created_at desc);

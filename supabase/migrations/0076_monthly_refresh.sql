-- ============================================================
-- 0076_monthly_refresh.sql
-- 月誌卷首語可以「重錄」：人自己按，才花錢
--
-- 原本卷首語每人每月生一次、存起來就不再動。月初問兩卦時打開月誌，
-- 它寫下「此後整月無聲」，之後再問二十幾卦也一直是那一段（六六 2026-09-29）。
--
-- 六六定的硬規則：
--   · 不自動重生。沒人按就不花錢——很多人根本不會回頭看月誌。
--   · 上次錄下之後又問了 3 卦以上，才出現「重錄」鈕；不到 3 卦只寫「其後又問 N 卦」。
--   · 每人每月最多重錄 4 次。第一次生成不算在內。
--   · 判斷一律在伺服器（xinji.ts 的 REFRESH_MIN／REFRESH_MAX），前端只照著畫。
-- ============================================================

alter table monthly_reviews add column if not exists casts_at_gen  int;
alter table monthly_reviews add column if not exists refresh_count int not null default 0;
alter table monthly_reviews add column if not exists updated_at    timestamptz;

comment on column monthly_reviews.casts_at_gen  is '錄下這段卷首語時，那一月已有幾卦。與現在的卦數相減＝其後又問了幾卦。';
comment on column monthly_reviews.refresh_count is '這一月已重錄幾次（首次生成不算）。上限見 xinji.ts REFRESH_MAX。';
comment on column monthly_reviews.updated_at    is '最近一次重錄的時間；沒重錄過為 null，以 created_at 為準。';

-- 已經存在的卷首語：補上「當時有幾卦」，照生成那一刻之前的卦數算（台北月）。
-- 不補的話，舊的那幾段會被當成「其後又問 0 卦」，按鈕永遠不出現——正好是要修的那個情況。
update monthly_reviews m
   set casts_at_gen = (
     select count(*) from casts c
      where c.user_id = m.user_id
        and c.created_at < m.created_at
        and to_char(c.created_at at time zone 'Asia/Taipei', 'YYYY-MM') = m.ym)
 where m.casts_at_gen is null;

-- 0089_plans_keep_days.sql — 三條線（0088_plans_three_lines）的卦保存天數
--
-- 0087 的保存分階只寫了舊三階（觀微 180／知幾 365／藏往永久）。新三階沒設的話
-- keep_days 是 null＝永久，三個方案都會變成永久收藏——比原本規劃的大方，而且之後再收回就是不利變更。
--
-- 問卦 365：卦是主軸，一年夠回頭對應期。
-- 攻略 180：主力在閒聊，卦是附帶。
-- 深度 永久：最高階，對齊舊藏往。
-- 無牒仍是 90 天（cast_keep_days 寫死）；印證過、收進心跡的卦不論方案一律永久（0087）。
--
-- 依賴 0087 加的 plans.keep_days；0087 沒跑時這支會失敗，先跑 0087。

update plans set keep_days = 365  where id = 'wengua';
update plans set keep_days = 180  where id = 'gonglue';
update plans set keep_days = null where id = 'shendu';

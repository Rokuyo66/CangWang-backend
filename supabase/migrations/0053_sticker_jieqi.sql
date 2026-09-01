-- 0053_sticker_jieqi.sql — 節氣包的 24 張貼紙。
--
-- 0046 建了 sticker_packs 的 'jieqi' 那一列（160 靈石），stickers 卻一列都沒有。
-- 於是那一包在抽屜裡打得開、標得出價，點進去是空的——買了也拿不到東西。
-- 這一支只補資料，不動 schema。
--
-- id 與 asset 同值，同 0046 既有的 12 張（前端 paintStickers 在沒有 asset 時
-- 會退回 sticker_id 當資產鍵，兩者一旦不同，畫面就會退成預設的銅錢）。
--
-- 圖不在這裡：assets/stickers/jieqi/<asset>.webp，由 build.mjs 複製進 dist/。
-- 貼上去多大也不在這裡——那是「這張畫」的性質，見 xinji.js 的 stkPx，
-- 理由同本表的 asset 欄註解：美術資產要能換、能補、能改畫，換張圖不該跑一次 migration。
--
-- sort 照節氣順序（立春起），與 _shared/jieqi.ts 的 JIEQI 同一個排法——
-- 抽屜是照 sort 排的，照筆劃或拼音排會讓「找下一個節氣」變成一件要用眼睛掃的事。

insert into stickers (id, pack_id, name, asset, sort) values
  ('lichun',      'jieqi', '立春', 'lichun',       1),
  ('yushui',      'jieqi', '雨水', 'yushui',       2),
  ('jingzhe',     'jieqi', '驚蟄', 'jingzhe',      3),
  ('chunfen',     'jieqi', '春分', 'chunfen',      4),
  ('qingming',    'jieqi', '清明', 'qingming',     5),
  ('guyu',        'jieqi', '穀雨', 'guyu',         6),
  ('lixia',       'jieqi', '立夏', 'lixia',        7),
  ('xiaoman',     'jieqi', '小滿', 'xiaoman',      8),
  ('mangzhong',   'jieqi', '芒種', 'mangzhong',    9),
  ('xiazhi',      'jieqi', '夏至', 'xiazhi',      10),
  ('xiaoshu',     'jieqi', '小暑', 'xiaoshu',     11),
  ('dashu',       'jieqi', '大暑', 'dashu',       12),
  ('liqiu',       'jieqi', '立秋', 'liqiu',       13),
  ('chushu',      'jieqi', '處暑', 'chushu',      14),
  ('bailu',       'jieqi', '白露', 'bailu',       15),
  ('qiufen',      'jieqi', '秋分', 'qiufen',      16),
  ('hanlu',       'jieqi', '寒露', 'hanlu',       17),
  ('shuangjiang', 'jieqi', '霜降', 'shuangjiang', 18),
  ('lidong',      'jieqi', '立冬', 'lidong',      19),
  ('xiaoxue',     'jieqi', '小雪', 'xiaoxue',     20),
  ('daxue',       'jieqi', '大雪', 'daxue',       21),
  ('dongzhi',     'jieqi', '冬至', 'dongzhi',     22),
  ('xiaohan',     'jieqi', '小寒', 'xiaohan',     23),
  ('dahan',       'jieqi', '大寒', 'dahan',       24)
on conflict (id) do nothing;

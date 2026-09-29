-- ============================================================
-- 0075_character_title_desc.sql
-- 角色身分加「描述」：給人看的一句話，暗示這個身分說話的立場與語氣
--
-- 六六 2026-09-29：身分卡底下不再寫「目前身分／可切換」（紅框就看得出是目前那個），
-- 第二行改寫這個身分是什麼。往後每個身分都要有一句。
--
-- 與 voice_hint 分開：voice_hint 是注進聊天的指令，寫給模型看，不下發到前端
-- （外流等於劇透兼被玩家調校，見 interpret 的 char_titles）；description 是寫給人看的，
-- 讀起來要像觀裡的介紹，不像指令。兩句說的是同一件事，口吻不同。
-- ============================================================

alter table character_titles add column if not exists description text;

comment on column character_titles.description is
  '給玩家看的一句身分描述（道籍›道緣›身分，卡片第二行）。暗示這個身分的立場與語氣，不寫好感尺度。'
  '與 voice_hint 分開：那一句只給模型、不下發。新身分（含事件表單自動生的）都要補這一句。';

update character_titles set description = '代掌觀中決策性事務，但有些事是做不了主的。'
  where id = 'daoshi_m_acting' and description is null;
update character_titles set description = '幾知觀掌門，須果決冷靜，主持正道。'
  where id = 'daoshi_m_zhangmen' and description is null;
update character_titles set description = '觀中大小雜務都經她手；誰來過、什麼擺在哪，她最清楚。'
  where id = 'daoshi_f_guanshi' and description is null;
update character_titles set description = '觀裡輩分最高的那位，誰都得讓牠三分；懶得管事，卻什麼都看在眼裡。'
  where id = 'lingshou_chong' and description is null;

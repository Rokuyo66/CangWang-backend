-- 0109_jianwen.sql — 道籍 › 見聞（六六 2026-10-24）。
-- 地點、場景、人物的名字與說明＝jianghu_config.world（企劃工作臺「見聞設定」寫，Claude 照存檔出 migration 上來）。
-- 去過哪、見過誰不另存：interpret 的 jw_board 照 jianghu_runs 重演算（_shared/jianwen.ts）。
alter table jianghu_config add column if not exists world jsonb not null default '{}'::jsonb;
comment on column jianghu_config.world is '見聞：{ places:[{id,name,desc}], scenes:{key:{name,place,desc,banner:{x,y,w}}}, people:{id:{role,desc}} }；工作臺「見聞設定」';
update jianghu_config set world = $jw${"places":[{"id":"yundu","name":"雲渡鎮","desc":"河上的小鎮，靠渡口吃飯。一年一度的擂龍台，魁首的名字刻在鎮口的龍柱上。"}],"scenes":{"dukou":{"name":"雲渡口","place":"yundu","desc":"擠在一起的渡船、跳板、木樁上的告示。渡錢從這裡收，也從這裡吵起來。"},"kezhan":{"name":"客棧","place":"yundu","desc":"渡口邊的小客棧，窗子正對河對岸萬金號的後門。"},"wanjin":{"name":"萬金號","place":"yundu","desc":"褚掌櫃的鋪子。前頭擺酒，後頭有一間帳房，燈總是最晚熄。"},"leitai":{"name":"擂龍台","place":"yundu","desc":"四根木樁打進河裡搭起的台子，底下是深潭。站上去的人，兩岸都看得見。"},"longzhu":{"name":"龍柱","place":"yundu","desc":"九丈高的柱子，刻滿往年魁首的名字。最底下那一圈，一直空著。"}},"people":{"n_aqin":{"role":"雲渡口的擺船人"},"n_lingxiao":{"role":"擂龍台三年魁首"},"n_chu":{"role":"萬金號掌櫃"},"n_zhou":{"role":"外地來的拳師"},"n_shen":{"role":"縣裡巡河的捕頭"}}}$jw$::jsonb where id = 'main';

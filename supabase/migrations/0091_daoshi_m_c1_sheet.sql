-- 大師兄第一章換成六六在劇本稿紙寫的版本（2026-10-20，稿紙 daoshi_m_c1 第 520 版）。
--
-- 舊稿（0042「代理」、卦書少一冊）是暫用的；新稿「雲中來信」：觀主來信，掌門印鑑交給大師兄。
-- 稿紙還標 draft——六六要先在 App 裡看效果，所以先上架給少數測試者看，之後改稿再出一支 migration。
-- 只動這一列與它的身分；玩家進度（user_character_events）不碰。
-- 門檻：修為 30、道緣不限。獎勵：靈石 10、身分「掌門師兄」（0038 那一列，label 不變，補聲口）。

update character_events set
  title               = '雲中來信',
  summary             = '大師兄今天一踏出觀門，就見觀外樹梢上卡了一封信。',
  require_favor       = 0,
  require_cultivation = 30,
  require_event       = null,
  scenes              = '[{"bg": "guanmen", "portrait": null, "text": "卯時，風涼，幾知觀大門從內展開，大師兄的身影出現在門後，他眼神還有些陰鬱，彷彿還在夢裡。"}, {"me": true, "text": "「大師兄？」\n你站在門前，與不知是不是心有靈犀大清早打開了門的大師兄對了眼。"}, {"portrait": "daoshi_m", "speaker": "大師兄", "text": "「......」\n他看了你一眼，似乎沒看進神裡，又抬頭看了眼樹梢，搖晃了下腦袋。\n愣了會兒，眨眨眼睛。\n「......有信。」"}, {"portrait": "lingshou", "who": "lingshou", "text": "「你們倆杵在門口做甚？」\n觀貓緩步踱到門前發楞的大師兄旁邊，順著大師兄眼神望過去。\n「那是信嗎？這封緘......小子你去拿來，是觀主吧。」"}, {"me": true, "text": "「離得那麼遠......這是怎麼見得觀主的？」\n你嘖嘖稱奇。"}, {"portrait": "daoshi_m", "who": "daoshi_m", "text": "大師兄走到樹下，袖口一翻，那白紙信封穩穩落到掌中，他低頭看了一眼。\n「師傅好眼力。」\n他走回來，你也跟著師兄、觀貓一起回到觀裡。"}, {"bg": "qianting", "place": "前廳", "portrait": "daoshi_f", "who": "daoshi_f", "text": "「你們在看什麼呢？你也來了，一道來用早膳吧。」\n師妹在前廳布置了早膳，招呼二人一貓，觀貓一點不客氣地跳上了桌。"}, {"portrait": "lingshou", "who": "lingshou", "text": "「要是白粥我就不要吃了。」觀貓搖晃著尾巴，「草魚！這麼大手筆，還是小姑娘上道，昨天小子準備早膳給我氣得......」\n"}, {"me": true, "text": "「師兄還會做早膳，下次我也能蹭飯嗎？」\n聞言觀貓呸了兩聲，嫌棄得很，碎念道愛吃誰吃。"}, {"portrait": "daoshi_f", "who": "daoshi_f", "text": "師妹抿唇微笑，「自然可以，不過，師兄素來吃得簡單。」\n她頓了一下看向大師兄。\n「師兄？」"}, {"portrait": null, "text": "師兄正展開了信件，就站在院子裡閱讀，聽聞呼喚抬起頭來，神情略顯茫然。"}, {"portrait": "lingshou", "who": "lingshou", "text": "「那老頭子說什麼了？」觀貓撓撓耳朵，邊繞到魚盤子前邊問。"}, {"portrait": "daoshi_m", "who": "daoshi_m", "text": "「觀主說……歸期難定，觀裡的事若需要掌門拿定讓我做主，掌門印鑑......是在我這裡，問事不必等他。」"}, {"text": "師妹與觀貓對視了一眼。\n前者笑了，後者打了個哈欠。"}, {"me": true, "text": "「看來要叫一聲掌門師兄了。」\n大師兄難得斜睨了你一眼，沒說話。"}, {"who": "lingshou", "text": "「這不是廢話？我們現在也是這麼幹的。」觀貓尾巴不耐煩地敲了敲桌面，「還有別的交代沒有？餓了！」"}, {"portrait": "daoshi_m", "who": "daoshi_m", "text": "師兄將信收折起來，走到桌前。\n「有的。」他看著觀貓欲言又止，終於還是開口。\n「......觀主說『要是貓不喝水就不給肉吃』，您先喝口水吧。」\n說罷，竟然伸手把那盤魚給端遠了去。"}, {"portrait": "daoshi_f", "who": "daoshi_f", "text": "師妹忍不住笑了出來，把手邊的茶杯推到觀貓面前。\n「觀主用心良苦，您快喝吧，喝完好吃魚，別讓掌門師兄為難。」"}, {"portrait": "lingshou", "who": "lingshou", "text": "「喵？！喵喵喵？！白水怎麼喝！沒點滋味！」觀貓鬧了起來，「小子，那老頭真讓你管我？你還記得你給我遞過拜師茶嗎？！」"}, {"portrait": "daoshi_m", "who": "daoshi_m", "text": "「記得。」\n大師兄又倒了一杯茶水，推過去。\n「但貓不喝水是大事，我得做主。」", "choices": [{"key": "c1", "label": "「果真是掌門師兄了......」", "hint": "能給貓作主了。"}, {"key": "c2", "label": "「確實是大事！」", "hint": "再上三碗水！"}], "end": true}]'::jsonb,
  choices             = null,
  rewards             = '{}'::jsonb,
  reward_lingshi      = 10,
  reward_avatar       = null,
  reward_title        = '掌門師兄',
  reward_memory       = null,
  published           = true
where id = 'daoshi_m_c1';

update character_titles set voice_hint = '你已接下掌門之位。話裡多了一分擔待，該拍板的事不再推諉；但你仍是那個師兄，對他的稱呼與分寸一如往常。'
 where unlock_event = 'daoshi_m_c1';

// _shared/cases/huangcun.ts — 卦案：荒村借宿
//
// 這是設計師寫死的世界。AI 只能從這裡選素材演繹，不得增加線索、NPC、區域，
// 不得改寫 truth，不得因卦象不同而改變真相。
//
// 六區綁六爻爻位（爻位取象見 case.ts YAO_IMAGE）。
// 用神取應：所問為無名分之陌生少女行蹤，非親非故不取六親（rules.ts 第 25 行）。
//
// 文本槽（onKey／onYuan／onJi／onStart／onRival）不必填滿——
// 跑 `node dev/case-lint.mts` 會依真隨機起卦的實際機率排出必填順序。

import type { CaseFile } from "../case-schema.ts";

export const HUANGCUN: CaseFile = {
  id: "huangcun",
  title: "荒村借宿",
  version: 1,
  question: "此行能否尋回失蹤的少女",
  useQin: "應",
  entryHour: 19, // 戌時進案（難度旋鈕：固定時辰會壓掉入墓局、提高平局比例）
  voidPolicy: "allow",

  // ⚠ 客觀真相：固定不變。無論玩家起出什麼卦、走哪條路線、是否找到她，這段事實都不改變。
  //   卦象只決定玩家從哪裡切入、代價多大，不決定這段是不是真的。
  //   truth 會在結案時原文呈現給玩家，所以這裡只寫故事本身，不寫給 AI 的約束——
  //   約束寫在註解，別寫進字串，否則玩家會在案件檔案裡讀到「無論玩家起出什麼卦」。
  truth:
    "少女確實還活著，被村長之弟藏在後山古碑後方的舊地窖裡。" +
    "他並非圖謀少女，而是二十年前那樁溺井舊案的當事人；少女在井邊撿到一件舊物，" +
    "他怕事發，先把人扣住再想辦法。村長知情而選擇沉默。",

  regions: [
    {
      pos: 1,
      name: "村口水井",
      image: "宅基·井·灶·地下",
      desc: "村子入口的老井，井臺石面被繩子磨出深溝。井水混濁，繩桶還濕著，像是不久前有人打過水。",
      objects: [
        { id: "o_well", name: "井臺", desc: "石縫裡卡著一小片藍布，邊緣是新扯斷的。", clue: "c_well_cloth" },
        { id: "o_trough", name: "石槽", desc: "餵牲口的石槽，底下積著一層陳年綠苔，近日無人使用。" },
      ],
      onKey: {
        open: "藍布片就明擺在井臺石縫上，你一蹲下就看見了——連找都不必找。",
        normal: "井臺石縫很深，得把繩桶挪開、蹲下來就著光看，才辨得出那不是苔痕而是布。",
        timed: "石縫裡確實有東西，但卡得極死。你需要一根撬子，或者等井水落下去一些。",
        broken: "藍布片被井繩反覆磨過，只剩指甲大一塊，看得出是布，看不出是誰的衣裳。",
      },
      onStart: "你們就是從這口井進村的。此刻回頭看，井臺是整個村子唯一還有人來往的痕跡。",
      onYuan: "打水的老人會主動同你搭話。他不知道自己說的哪句有用，但他願意說。",
    },
    {
      pos: 2,
      name: "主屋堂室",
      image: "宅·堂屋·廚房·內室",
      desc: "借宿的空屋，堂上供桌積灰，唯獨灶臺乾淨。屋主據說出外多年未歸。",
      objects: [
        { id: "o_stove", name: "灶臺", desc: "灶膛裡的灰還帶餘溫，鍋底有新刷過的水痕。", clue: "c_ash" },
        { id: "o_table", name: "供桌", desc: "牌位被人取走了，供桌上留著兩道沒積灰的方印。" },
        { id: "o_tools", name: "牆角農具", desc: "幾把生鏽的鋤頭鐮刀，堆裡插著一根短撬，柄上的漆磨得發亮。", clue: "c_pry" },
      ],
      onKey: {
        open: "灶膛的餘溫燙手。有人今晚在這裡煮過東西，而且不只一人份。",
        normal: "灶灰摸上去是涼的，但撥開表層，底下還悶著沒散盡的熱。",
      },
      onStart: "你們的行李還擱在堂上。這間屋子是今晚唯一能回來的地方。",
      onJi: "屋子太靜了。你每動一下，聲音都往外傳——在這裡待久了，村子就知道你在查什麼。",
    },
    {
      pos: 3,
      name: "西廂臥房",
      image: "門·床·臥房",
      desc: "西邊廂房，門閂是從外面上的。床鋪整齊得反常，被褥疊得像沒人睡過。",
      objects: [
        { id: "o_bed", name: "木床", desc: "床板縫裡纏著一截紅頭繩，扯斷的一頭還很新。", clue: "c_bed_hair" },
        { id: "o_chest", name: "舊櫃", desc: "空的。櫃底有一圈灰痕，原本擱過一只不小的箱子。" },
      ],
      onKey: {
        open: "紅頭繩就掛在床沿，扯斷的那頭朝著門口——她是從這裡被帶走的。",
        normal: "得把床板一塊塊掀開。第三塊底下的縫裡卡著一截紅頭繩。",
      },
      onRival: "門閂是從外面上的。上閂的人現在還在村子裡。",
    },
    {
      pos: 4,
      name: "院牆廢廟",
      image: "戶·大門·外牆·近鄰",
      desc: "院牆外緊挨著一座塌了半邊的小廟，神像早沒了，殘案上香灰卻是新的。",
      objects: [
        { id: "o_altar", name: "殘案", desc: "香灰下壓著一張殘破黃紙，字被水糊掉大半。", clue: "c_temple_paper" },
        { id: "o_wall", name: "牆缺口", desc: "院牆塌了一個口子，缺口下方的土被踩得很實，不只一趟。" },
      ],
      onKey: {
        open: "黃紙就在香灰上頭，一翻就見。上頭寫的是二十年前的日子。",
        normal: "香灰壓得厚，得一層層撥開才見著紙角。紙糊了大半，勉強認得出年份。",
      },
      onJi: "有人在廟裡上過香，而且時間就在今晚。你在這裡翻動的每一下，都可能被那人聽見。",
    },
    {
      pos: 5,
      name: "山路村長家",
      image: "道路·行人·官府·人口",
      desc: "通往後山的土路從村長家門前經過。院裡燈還亮著，門卻閂上了。",
      objects: [
        { id: "o_road", name: "山路泥地", desc: "泥地上有一道拖痕，往後山去，旁邊跟著一雙深腳印。", clue: "c_road_track" },
        { id: "o_gate", name: "村長家門", desc: "門閂上了，門縫底下透出燈光。裡頭有兩個人的說話聲，一個壓著一個。" },
      ],
      onKey: {
        open: "拖痕在泥地上清清楚楚，一路指向後山，連遮都沒遮。",
        normal: "泥地被人用腳來回抹過，但邊緣還留著沒抹淨的一段，方向朝後山。",
      },
      onRival: "村長家的燈亮著。他知道你在查，他也知道你會來敲他的門。",
      onJi: "路上總有村人「恰好」經過。你每往後山走一步，身後的眼睛就多一雙。",
    },
    {
      pos: 6,
      name: "後山古碑",
      image: "宗廟·屋頂·牆外·最高最遠",
      desc: "後山半腰立著一塊無字古碑，碑身被山霧浸得發黑。碑後的浮土顏色比周圍新。",
      objects: [
        { id: "o_stele", name: "古碑", desc: "碑面近底處有一道新鑿的痕，像是為了搬動它而下的鑿子。", clue: "c_stele_mark" },
        { id: "o_pit", name: "碑後浮土", desc: "浮土下是一塊活動的板子，邊緣嵌得死緊，徒手掀不動。", clue: "c_cellar", needsItem: "c_pry" },
      ],
      onKey: {
        open: "新鑿痕就在碑腳，山霧再重也遮不住。有人近日動過這塊碑。",
        normal: "碑身太黑，得貼近了、用手摸過去，才辨得出哪一道是舊裂哪一道是新鑿。",
        timed: "霧太重，看不清碑面。得等霧散一陣，或者等天再亮一點。",
        broken: "鑿痕被雨水沖過，只剩一段。認得出有人動過，認不出是什麼時候動的。",
      },
      onRival: "碑後有人。你聽不見腳步，但浮土上的風換了方向。",
      onYuan: "同行的人先你一步蹲到碑腳去了——他看見了你還沒看見的東西。",
    },
  ],

  // says 依序判定：needs 都在手上、且尚未聽過，才會說出來。
  // 「若無其他證據就撬不開他的口」是靠 needs 做成真的機制，不是氛圍文字。
  npcs: [
    {
      id: "n_chief", name: "村長", region: 5,
      voice: "話少，答得慢，每一句都先想過。被問急了就說「山裡的事，山裡了」。",
      says: [
        { text: "村裡近來太平，沒見過什麼外地姑娘。天黑了，客人早些歇著。" },
        { needs: ["c_villager_lie"], text: "他沉默了很久，才說弟弟那晚確實出過門——去山上收柴，回來得晚，他親眼看見的。話說得太順，像預先想好的。" },
        { needs: ["c_temple_paper", "c_villager_lie"], text: "看見那張黃紙上的日子，他把茶杯放下了。「那年的事，村裡不提。」再問就不肯開口。" },
      ],
    },
    {
      id: "n_brother", name: "村長之弟", region: 4,
      voice: "話多、搶著解釋，手不肯放下來。越是無關的事講得越細。",
      says: [
        { text: "他一口氣講了半刻鐘的收成與山路難走，沒有一句和人有關。" },
        { needs: ["c_road_track"], clue: "c_villager_lie", text: "提起山路上的拖痕，他的手停了一下，隨即說整晚沒出過門。說得太快，快得像早就備著。" },
      ],
    },
    {
      id: "n_widow", name: "井邊老婦", region: 1,
      voice: "耳背，講話大聲，翻來覆去講二十年前那樁溺井的事，沒人愛聽。",
      says: [
        { text: "「那井裡的，不是自己跳的。」她說了三遍，村裡人繞著走。" },
        { needs: ["c_well_cloth"], text: "她盯著那片布看了很久，說徐娘那日穿的就是這個顏色。然後笑了一下，那個笑不像瘋子。" },
      ],
    },
  ],

  clues: [
    { id: "c_well_cloth", kind: "knowledge", name: "井臺藍布片", region: 1, text: "井臺石縫裡的藍布片，是新扯斷的。少女失蹤那日穿的正是藍衫。" },
    { id: "c_ash", kind: "knowledge", name: "未冷的灶灰", region: 2, text: "空屋的灶今晚有人生過火，而且煮的份量不只一人。" },
    { id: "c_pry", kind: "item", name: "短撬", region: 2, text: "農具堆裡抽出來的短撬，一尺來長，撬得動嵌死的板子。" },
    { id: "c_bed_hair", kind: "knowledge", name: "床下紅頭繩", region: 3, text: "西廂床板縫裡的紅頭繩，斷口朝門。她曾被關在這間屋子裡。" },
    { id: "c_temple_paper", kind: "knowledge", name: "廢廟殘黃紙", region: 4, text: "殘破黃紙上寫著二十年前的日子——正是那樁溺井舊案的日子。" },
    { id: "c_road_track", kind: "knowledge", name: "山路拖痕", region: 5, text: "泥地上的拖痕通往後山，旁邊的腳印一深一淺，是負重的人留下的。" },
    { id: "c_villager_lie", kind: "knowledge", name: "村長之弟的矛盾口供", region: 5, text: "他說整晚沒出過門，但村口的人記得他戌時往後山去過。", requires: ["c_road_track"] },
    { id: "c_stele_mark", kind: "knowledge", name: "古碑新鑿痕", region: 6, text: "碑腳的新鑿痕是為了搬動碑身而下的，就在這幾日。" },
    { id: "c_cellar", kind: "knowledge", name: "碑後地窖入口", region: 6, text: "浮土下的活動板子掀開後有風上來——底下是空的，而且通著人待得住的地方。", requires: ["c_stele_mark", "c_temple_paper"] },
  ],

  // 三個角色是三種觀察者，可搜索區與可取得線索刻意不重疊——
  // 帶誰進來就決定你先看見案子的哪一半（規格書第八節）。
  companions: [
    {
      id: "daoshi_m", // 師兄：古籍、符號、陣法、建築
      regions: [4, 5, 6],
      clues: ["c_temple_paper", "c_road_track", "c_stele_mark"],
      trigger: "玩家停滯 15 分鐘，或玩家已取得任一線索且當前不在該區",
    },
    {
      id: "daoshi_f", // 師妹：人際、情緒、言語漏洞
      regions: [1, 2, 5],
      clues: ["c_well_cloth", "c_ash", "c_villager_lie"],
      trigger: "玩家停滯 15 分鐘，或玩家已與任一 NPC 對話過",
    },
    {
      id: "lingshou", // 觀喵：靈異、氣味、動物異常、禁忌
      regions: [1, 3, 6],
      clues: ["c_well_cloth", "c_bed_hair", "c_stele_mark"],
      trigger: "玩家停滯 10 分鐘，或世界時間入夜（21 時後）",
    },
  ],
};

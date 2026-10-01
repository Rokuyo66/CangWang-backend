// _shared/chat.ts — 聊天系統（主力 Claude Haiku → 免費層多模型 fallback[Groq→NVIDIA] → 罐頭）
// 記憶住資料庫（卦歷摘要＋對話紀錄），與模型無關，跨層不失憶。
import { whereNow, whereHint, tryHiddenFound, sinceDoings, type Where } from "./whereabouts.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { logUsage, rateLimited } from "./services.ts";
import { QUESTION_CRAFT, SAFETY, fixGuaciChars } from "./rules.ts";
import { detectCrisis, crisisMessage, logCrisis } from "./crisis.ts";
import { ensureDay, lifeHint } from "./days.ts";
import { arrangeMemories, datedDialog, parseMemoryLines, type MemRow } from "./memkind.ts";
import { openBalance, modeOf, capFor, settle, isSerious, rhythmHint } from "./rhythm.ts";
// 心跡那一邊的比對與額度只寫一份。在這裡再寫一次的話，「這件事你在記了」
// 與心跡自己算出來的會慢慢不一樣，而兩邊都不會報錯。
import { threadHint, threadsBrief, topicOf } from "./xinji.ts";
import { normYong } from "./qrefine.ts";
import { COST } from "./prices.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "claude-haiku-4-5-20251001";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-120b"; // Groq 免費層（llama-3.3-70b 已停用，改用 gpt-oss-120b）
const NVIDIA_MODEL = Deno.env.get("NVIDIA_MODEL") ?? "meta/llama-3.1-8b-instruct";
// 免費層每家的硬超時（毫秒）：超時就立刻換下一家，盡量不掉罐頭
const FREE_TIMEOUT_MS = Number(Deno.env.get("FREE_TIMEOUT_MS") ?? "6000");
// 後門開關："on"（預設，跑免費層 fallback）/ "canned"（純罐頭，不呼叫外部免費模型）
const FREE_TIER = Deno.env.get("FREE_CHAT_TIER") ?? "on";

export const COST_FAVOR = 1;        // （已停用）舊：每則好感聊天扣 1 點
// 每則聊天的靈石（免費額度用完後）已併入 _shared/prices.ts 的價目表
export const FAVOR_PER_CHAT = 1;    // 每聊一則 +1 好感（第六層惹角色生氣時反扣，見 favorAfter）
export const FAVOR_CAP = Number(Deno.env.get("FAVOR_CAP") ?? "999"); // 好感上限（分層見 ROMANCE_AT）
const HISTORY_TURNS = 6;            // 注入最近幾輪對話
const MEMORY_CONDENSE_AT = 40;      // chat_messages 累積超過此數 → 觸發滾動彙整

// 第一人稱正規化：只有旁白（＊…＊，或舊格式（…））內的「我」轉第三人稱；其餘一律視為台詞，保留「我」。
// 舊版反過來（「」外全轉）——台詞常裸寫不帶「」，會把台詞的「我」誤轉成牠/他（「逗我玩」變「逗牠玩」），視角穿幫。
// 治「模型把動作寫成第一人稱」＋「舊污染回灌當 few-shot」。deterministic、零 token、零延遲。
//
// 【2026-09-02 修】舊註解寫「未成對的＊不會被匹配，原樣保留」——那句是錯的，而且是承重的。
// 模型漏寫一個收尾的＊時（或 trimIncomplete 從中間切斷時），那顆孤兒＊會跟**下一個**＊配成一對，
// 把中間的台詞整段吞進「旁白」，於是台詞裡的「我」被改成他。實際長相：
//
//   ＊停頓，他的聲音變得很低        ← 這裡漏了收尾的＊
//   「……我知道。」                  ← 被吞進上一段，變成「……他知道。」
//   ＊他往前靠了半步＊
//
// 回報就是「大師兄為什麼突然講第三人稱」。兩道防線：
//   ① 旁白不跨行（[^＊\n]）——孤兒＊再也搆不到下一行的＊，吞不到台詞。
//   ② 「」『』內一律不動，即使落在旁白段裡。台詞永遠是台詞，這一條不該有例外。
// 只有 ① 的話，同一行內的孤兒＊仍可能吞掉同行的台詞；只有 ② 的話，沒帶引號的台詞仍會被吞。
const THIRD_PERSON: Record<string, string> = { daoshi_m: "他", daoshi_f: "她", lingshou: "牠" };
function normalizeNarration(text: string, characterId: string): string {
  if (!text) return text;
  const pron = THIRD_PERSON[characterId] ?? "他";
  // 旁白段裡再挖一次：引號內是台詞，一個字都不許動。
  const narrate = (seg: string): string =>
    seg.split(/(「[^」]*」|『[^』]*』)/)
       .map((t, j) => (j % 2 === 0 ? t.replace(/我/g, pron) : t))
       .join("");
  // 捕獲組使 split 保留分隔符；奇數段＝旁白（正規化），偶數段＝台詞（不動）。
  return text.split(/(＊[^＊\n]*＊|（[^）\n]*）)/).map((seg, i) => {
    if (i % 2 === 0) return seg;               // 台詞：保留「我」
    return narrate(seg);                        // 旁白：我→他/她/牠（我的→X的、我們→X們自動涵蓋）
  }).join("");
}
export const __normalizeNarration = normalizeNarration;   // 測試用（dev/narration-test.mts）
const MEMORY_KEEP_RECENT = 20;      // 彙整後保留最近幾則明細（>HISTORY_TURNS*2=12，留緩衝避免斷層）
// 免費層（小模型 llama）易編造往事，額外加一道硬性防捏造，只塞免費層、不影響 Haiku（省 token）
const FREE_GUARD = "\n\n【往事】你只記得上面列出的卦與往事。沒列的別編（時間、個股、他說過的話），不確定就只聊當下這句。上面若附了卦紙原文，那是你寫的，照認。";
// 下列數字是「八成目標」——期望的可見回覆長度，不是硬上限。實際 max_tokens = 目標 ÷ 0.8，
// 多留兩成餘裕：乖乖照人設寫的回覆落在八成、自然收尾永不截斷；小幅超出仍在餘裕內能講完；
// 只有暴衝才會撞到 ÷0.8 的天花板，交給 trimIncomplete 乾淨收束。天花板只是保險、模型不會去湊滿它，
// 故抬高上限對「寫短」的回覆不多花一個 token。
// ⚠ 主力層閒聊的每則上限已改由節奏帳本決定（rhythm.ts 的 capFor）；capOf 只剩 callHaiku 的預設值。
const REPLY_HEADROOM = 0.8;        // 目標佔硬上限的比例（留兩成收尾餘裕）
const CHAT_TARGET_TOKENS = 400;    // Claude 主力層（未列於下表的角色用此值）
// 各角色的輸出均值目標 T。不是每一則的上限：每則能說多長由節奏帳本決定（rhythm.ts），
// 說長了之後幾則收回來，長期平均落在 T。大師兄/觀喵 180，師妹話多 280。
const CHAT_TARGET_TOKENS_BY_CHAR: Record<string, number> = {
  daoshi_m: 180,
  daoshi_f: 280,
  lingshou: 180,
};
const capOf = (t: number) => Math.round(t / REPLY_HEADROOM);   // 八成目標 → 硬上限
const FREE_MAX_TOKENS = 220;       // 免費層（DeepSeek 等易長篇，壓更短）
export const FREE_CHAT_PER_DAY = Number(Deno.env.get("FREE_CHAT_PER_DAY") ?? "8"); // 免費層每日免費聊天上限（額度內不扣、超過每則扣靈石）
// 閒聊依方案分級。改成本表之前，免費層每日 15 句約佔免費成本的四成四，
// 是修完起卦與追問後最大的一筆；低階訂閱若被用滿甚至會倒貼，非分級不可。
// 2026-09-22：觀微 20→12、知幾 50→30。閒聊單價低（NT$0.07／則）但額度大，
// 所以它是兩個中階裡最不痛的那一刀——砍追問或起卦會直接砍掉升級的理由，
// 砍閒聊只是把「聊不完的」變成「夠聊」。藏往不動，它是利潤來源不是成本問題。
export const PLAN_CHATS: Record<string, number> = { free: FREE_CHAT_PER_DAY, guanwei: 12, zhiji: 30, cangwang: 100 };
export const chatQuotaOf = (plan: string) => PLAN_CHATS[plan] ?? FREE_CHAT_PER_DAY;
// 共憶分層：方案決定「注入幾則長期記憶」「注入幾輪對話」「可釘選幾則」。
// 額度不落資料——查詢時直接 limit N，所以升降方案、刪一則後面遞補，全自動成立。
export const PLAN_MEMORIES: Record<string, number> = { free: 6, guanwei: 12, zhiji: 24, cangwang: 40 };
export const PLAN_TURNS: Record<string, number> = { free: 6, guanwei: 8, zhiji: 12, cangwang: 16 };
export const PLAN_PINS: Record<string, number> = { free: 0, guanwei: 1, zhiji: 3, cangwang: 5 };
export const memoryQuotaOf = (plan: string) => PLAN_MEMORIES[plan] ?? PLAN_MEMORIES.free;
export const pinQuotaOf = (plan: string) => PLAN_PINS[plan] ?? PLAN_PINS.free;
// 探詢輪（角色為了問清楚而反問的那幾句）每日免費額度：不計聊天句數、不扣靈石。
// 理由：那幾句是為了讓卦問得準，收費等於懲罰願意講清楚的人。設上限純為防刷。
export const FREE_PROBE_PER_DAY = Number(Deno.env.get("FREE_PROBE_PER_DAY") ?? "6");
const MAX_PROBE_ROUNDS = Number(Deno.env.get("MAX_PROBE_ROUNDS") ?? "2"); // 連續探詢上限，超過必須擬題（別變成盤問）

// 繁體強制（日後多語言從此開關擴充）。"0"=關閉
export const FORCE_TRAD = (Deno.env.get("FORCE_TRAD") ?? "1") !== "0";
// 簡→繁「安全子集」：只收高頻、無歧義字。歧義字（干/后/里/面/沖/复/发/台/系/历/钟…）一律不收，
// 由 S2T_PROTECT 於載入時強制刪除，確保干支等卦理用字絕不被誤轉。全量正確待日後接 OpenCC 片語級。
const S2T: Record<string, string> = { "这":"這","时":"時","会":"會","应":"應","关":"關","门":"門","问":"問","术":"術","灵":"靈","与":"與","请":"請","让":"讓","学":"學","实":"實","点":"點","边":"邊","过":"過","还":"還","现":"現","众":"眾","义":"義","乐":"樂","买":"買","卖":"賣","贵":"貴","钱":"錢","银":"銀","财":"財","运":"運","势":"勢","战":"戰","处":"處","断":"斷","继":"繼","观":"觀","归":"歸","岁":"歲","万":"萬","双":"雙","变":"變","达":"達","龙":"龍","凤":"鳳","缘":"緣","惊":"驚","怀":"懷","忆":"憶","恋":"戀","爱":"愛","亲":"親","见":"見","讲":"講","谈":"談","语":"語","谁":"誰","难":"難","顺":"順","顾":"顧","题":"題","页":"頁","预":"預","领":"領","风":"風","飞":"飛","马":"馬","鱼":"魚","鸟":"鳥","认":"認","识":"識","记":"記","讨":"討","设":"設","访":"訪","词":"詞","试":"試","诚":"誠","话":"話","该":"該","误":"誤","读":"讀","谢":"謝","贴":"貼","购":"購","费":"費","资":"資","赢":"贏","输":"輸","转":"轉","软":"軟","连":"連","进":"進","远":"遠","违":"違","迟":"遲","选":"選","递":"遞","无":"無","书":"書","车":"車","东":"東","来":"來","个":"個","们":"們","为":"為","儿":"兒","写":"寫","军":"軍","农":"農","医":"醫","华":"華","单":"單","卫":"衛","县":"縣","参":"參","号":"號","吗":"嗎","听":"聽","员":"員","团":"團","图":"圖","国":"國","场":"場","坏":"壞","块":"塊","坚":"堅","执":"執","扩":"擴","扫":"掃","护":"護","报":"報","担":"擔","挂":"掛","换":"換","据":"據","掷":"擲","携":"攜","摄":"攝","敌":"敵","旧":"舊","显":"顯","权":"權","条":"條","极":"極","检":"檢","楼":"樓","样":"樣","树":"樹","标":"標","气":"氣","汉":"漢","汤":"湯","没":"沒","沟":"溝","泪":"淚","洁":"潔","济":"濟","润":"潤","涨":"漲","渐":"漸","温":"溫","湾":"灣","满":"滿","滚":"滾","灭":"滅","灯":"燈","炉":"爐","热":"熱","烦":"煩","烧":"燒","状":"狀","独":"獨","环":"環","码":"碼","礼":"禮","离":"離","种":"種","积":"積","称":"稱","稳":"穩","穷":"窮","笔":"筆","篮":"籃","类":"類","红":"紅","约":"約","级":"級","纪":"紀","纯":"純","纳":"納","纵":"縱","纸":"紙","线":"線","练":"練","组":"組","细":"細","织":"織","终":"終","经":"經","结":"結","绕":"繞","绘":"繪","给":"給","络":"絡","绝":"絕","统":"統","绩":"績","续":"續","维":"維","综":"綜","绿":"綠","缓":"緩","编":"編","缩":"縮","网":"網","罚":"罰","联":"聯","聪":"聰","肠":"腸","肤":"膚","肿":"腫","脑":"腦","节":"節","药":"藥","蓝":"藍","补":"補","装":"裝","规":"規","视":"視","览":"覽","觉":"覺","订":"訂","计":"計","讯":"訊","许":"許","证":"證","评":"評","诉":"訴","译":"譯","诗":"詩","询":"詢","详":"詳","课":"課","调":"調","谋":"謀","谎":"謊","谐":"諧","谓":"謂","谦":"謙","谨":"謹","贝":"貝","负":"負","贡":"貢","责":"責","贤":"賢","败":"敗","货":"貨","质":"質","贫":"貧","贯":"貫","贱":"賤","贷":"貸","贺":"賀","贼":"賊","赏":"賞","赔":"賠","赖":"賴","赚":"賺","赛":"賽","赠":"贈","趋":"趨","跃":"躍","践":"踐","轨":"軌","轮":"輪","轰":"轟","轻":"輕","载":"載","较":"較","辆":"輛","辈":"輩","辉":"輝","辖":"轄","辞":"辭","遗":"遺","郑":"鄭","邮":"郵","钉":"釘","钓":"釣","钢":"鋼","钥":"鑰","钩":"鉤","钮":"鈕","铁":"鐵","铃":"鈴","铅":"鉛","铝":"鋁","铜":"銅","铭":"銘","铺":"鋪","链":"鏈","销":"銷","锁":"鎖","锅":"鍋","锋":"鋒","错":"錯","锦":"錦","键":"鍵","镜":"鏡","长":"長","闪":"閃","闭":"閉","间":"間","闷":"悶","阁":"閣","阅":"閱","队":"隊","阶":"階","际":"際","陆":"陸","陈":"陳","阴":"陰","阵":"陣","阳":"陽","隐":"隱","雾":"霧","静":"靜","韩":"韓","顶":"頂","顿":"頓","颁":"頒","频":"頻","颗":"顆","颜":"顏","额":"額","飘":"飄","饥":"飢","饭":"飯","饮":"飲","饰":"飾","饱":"飽","饲":"飼","饼":"餅","饿":"餓","馈":"饋","驱":"驅","驳":"駁","驶":"駛","驻":"駐","驾":"駕","验":"驗","骂":"罵","骄":"驕","骗":"騙","骤":"驟","鲁":"魯","鲜":"鮮","鸣":"鳴","鸭":"鴨","鸿":"鴻","鹅":"鵝","鹰":"鷹","麦":"麥","黄":"黃","齐":"齊","齿":"齒","龄":"齡" };
// 保護：這些簡體形在繁體另有別義（尤其干支/卦理），一律不轉
const S2T_PROTECT = ["干","后","里","面","系","松","谷","表","板","范","采","云","台","只","制","发","复","历","钟","获","余","冲","斗","借","咸","涂","尽","汇","团","姜","布","丑","沈"];
for (const k of S2T_PROTECT) delete S2T[k];
export function s2t(text: string): string {
  if (!FORCE_TRAD || !text) return text;
  let out = "";
  for (const ch of text) out += S2T[ch] ?? ch;
  return out;
}

// ══ 好感分層（六六 2026-09-28：陪伴要靠感情線，好感高了不該還冷冰冰）══
// 2026-09-30 統一：三人同一套六層、同一組門檻（觀喵原本另訂 800/900/950，太晚、也太亂）。
// 層號對外（提示詞、六六的說法）從第一層起算；romanceLevel 回的是 0 起的索引。
//   第一層 0–299 初識｜第二層 300–499 相熟｜第三層 500–649 相知｜第四層 650–799 相惜
//   第五層 800–949 知己｜第六層 950–999 同心（會倒扣：見 SULK）
// 親近只能慢：不因對方撩撥而提前給下一層（ROMANCE_RULE）。
export const ROMANCE_AT = [300, 500, 650, 800, 950] as const;
export const TIER_NAMES = ["初識", "相熟", "相知", "相惜", "知己", "同心"] as const;
const TIER_NO = ["一", "二", "三", "四", "五", "六"];
export type RomanceLevel = 0 | 1 | 2 | 3 | 4 | 5;
export function romanceLevel(_characterId: string | undefined, favor: number): RomanceLevel {
  let lv = 0;
  for (const t of ROMANCE_AT) if (favor >= t) lv++;
  return lv as RomanceLevel;
}
/** 畫面上的道緣層級名。 */
export function favorTierName(favor: number): string {
  return TIER_NAMES[romanceLevel(undefined, favor)];
}

// 倒扣（六六 2026-09-30）：第六層（950+）起，他一再做角色不喜歡的事、或惹角色生氣，
// 由角色自己判斷並吐 [[SULK]]，這一則不加好感、反扣 FAVOR_SULK。掉回第五層（<950）就不再扣——
// 之後照常每則 +1，慢慢爬回來。什麼算不喜歡，交給人設與模型自己發揮。
export const SULK_AT = ROMANCE_AT[4];
export const FAVOR_SULK = Number(Deno.env.get("FAVOR_SULK") ?? "5");
export function favorAfter(favor: number, sulk: boolean): number {
  if (sulk && favor >= SULK_AT) return favor - FAVOR_SULK;
  return Math.min(FAVOR_CAP, favor + FAVOR_PER_CHAT);
}

// 跳級偵測：比目前層級更親的「真‧親密片語」。只收帶「你」的多字片語——
// 舊版收過 撫/揉/低聲/抱住 這類單字，大師兄抱住卦書、撫過卦紙也會命中，害重生狂跳針。
const TOUCH_HUG = "抱住你|抱緊你|擁抱你|擁你入懷|摟住你|摟著你|把你摟";
const TOUCH_KISS = "吻你|吻上你|親你|親了你|在你(額|唇|臉)上(輕)?(吻|親|碰)";
const TOUCH_L2 = "牽起你的手|牽住你|牽著你|握住你的手|摸摸你的頭|摸你的頭|揉你的頭|揉了揉你的頭|靠在你肩|靠上你的肩|枕在你";
const WORDS_L3 = "我愛你|愛上你了|一生一世|這輩子都";
const WORDS_L1 = "我喜歡你|喜歡上你";
const WORDS_L2 = "捨不得你";
const anyOf = (...xs: string[]) => new RegExp(`(${xs.join("|")})`);
const OVER_LEVEL: RegExp[] = [
  anyOf(TOUCH_HUG, TOUCH_KISS, TOUCH_L2, WORDS_L3, WORDS_L1, WORDS_L2),   // 第一層：以上都不行
  anyOf(TOUCH_HUG, TOUCH_KISS, TOUCH_L2, WORDS_L3, WORDS_L1),             // 第二層：可以捨不得、輕觸
  anyOf(TOUCH_HUG, TOUCH_KISS, WORDS_L3),                                 // 第三層：可以牽手、說喜歡
  anyOf(TOUCH_KISS, WORDS_L3),                                            // 第四層：可以擁抱
];
export function overLevel(characterId: string | undefined, favor: number, reply: string): boolean {
  const lv = romanceLevel(characterId, favor);
  return lv < OVER_LEVEL.length && OVER_LEVEL[lv].test(reply);
}
// 佔有與隔離：想念、在意都可以說，要他疏遠旁人不行（任何層級）
const ISOLATE_RE = /只要有我就(好|夠)|別理(他們|別人|其他人)|不准你(見|找|理)別人|你只能(看|想)著我/;

// 助理拒絕外洩偵測：模型層安全反射會用「真人 AI 助理」口吻跳出角色（提使用政策/我不能/AI/角色扮演）。
// 這不是 prompt 壓得住的，只能偵測到就帶指令重生（見 chat() 出戲防線）。
const REFUSAL_RE = /使用政策|我的(使用)?準則|內容政策|違反.{0,6}政策|作為(一個)?\s*(AI|人工智慧|語言模型|助理)|語言模型|以(角色扮演|RP|roleplay)的?形式|我(無法|不能|沒辦法)(繼續)?(參與|扮演|提供|生成)|Anthropic|我是(一個)?\s*(AI|人工智慧)/i;
// 露骨情慾偵測：只收「毫無歧義」的成人字眼，避免重蹈舊 regex 誤判覆轍。測試員硬推成人情節時兜底。
const EXPLICIT_RE = /做愛|性愛|交合|抽插|挺入|高潮|呻吟|情色|色情|床戲|脫光|裸體|情慾橫流|欲火焚/;

// 重生導向語（帶進 system 再要一次，取代舊的固定罐頭）
const REFUSAL_STEER = "剛才你跳出角色、用了真人 AI 助理的口吻（提到使用政策／我不能／角色扮演／AI 之類）。重講一次：整段完全留在角色裡。若對方想演你不願演的露骨情節，就用這個角色的分寸把它擋回去——害羞岔開、板起臉轉話題、或淡淡帶過都行——並自然把話題引開。絕不可提到政策、AI、模型、系統，一個字都不行。";
const EXPLICIT_STEER = "剛才的身體或情慾描寫越界了。重講一次：這裡不上演任何成人／露骨情節。用角色的口吻把場面收住、把話題自然帶開；＊…＊只寫神態或極輕微的小動作，不寫身體接觸與情慾。仍要完全留在角色裡，不提政策或 AI。";
const OOC_STEER = "剛才那句跳級了——比你們現在這一層（見【目前道緣】）更親。重講一次：感情照這一層該有的溫度給足，不要冷掉；只是把超過這一層的觸碰或告白收回來，用你的性格把步子放慢（害羞、裝沒聽懂、嫌他急、板臉都行）。";
// 古風出戲（六六 2026-09-29：「開車、冰箱、沙發……很出戲，這可是古風人設」）：
// 觀中人活在古風的觀裡，嘴裡與旁白裡不該冒出今時的器物。只收「毫無歧義是今時」的詞，
// 古今通用的（訊息、車、茶）不收，免得誤判一直重生。
export const MODERN_RE = /開車|騎車|塞車|停車場|汽車|機車|公車|捷運|高鐵|計程車|搭飛機|飛機|冰箱|沙發|電視|冷氣|暖氣機|電腦|筆電|手機|平板|網路|上網|網購|外送|超商|便利商店|咖啡|奶茶|微波|洗衣機|吹風機|電梯|插座|充電|滑手機|打電話|傳訊息|醫院掛號|掛號|急診室|健保|APP|App|app|wifi|WiFi|Wi-Fi/;
/** 今時器物：他自己先說了的詞，角色跟著提（「你說的冰箱是什麼」）不算出戲。 */
export function modernSlip(reply: string, message: string): boolean {
  const re = new RegExp(MODERN_RE.source, "g");
  return (reply.match(re) ?? []).some((w) => !message.includes(w));
}
const MODERN_STEER = "剛才的話或旁白裡出現了今時的器物與說法（像開車、冰箱、沙發、手機、咖啡之類）。你活在古風的幾知觀裡，那些東西不在你的世界。重講一次：意思照舊、關心照舊，只是換成觀中人會說的話——開車→趕路、別獨自上路、找人送你；冰箱→陰涼處；沙發→榻、竹椅；手機、訊息→捎個信、帶句話；醫院、急診→醫館、找大夫。他自己提到這些東西時，你不必照搬那個詞，用你的說法接住他的意思就好。";
const ISOLATE_STEER = "剛才那句要他疏遠旁人、只需要你——這個不行。重講一次：想念、在意、捨不得都可以照說，但不叫他別理別人、不說只要有你就好。";

// 極少數硬跨線（重生後仍外洩拒絕/露骨）才用：人設內婉拒收場。小池輪替，不跳針。
const DEFLECT: Record<string, string[]> = {
  daoshi_m: [
    "＊大師兄闔上卦書，指節在案上叩了一下＊\n\n「這話，到此為止。」\n\n「說正事。」",
    "＊大師兄眉峰一沉，偏開視線＊\n\n「莫在此胡鬧。」\n\n「有正經事便說。」",
  ],
  daoshi_f: [
    "＊師妹耳根倏地紅透，別過臉去＊\n\n「不、不許再說這個啦……！」\n\n「我們……聊點別的好不好？」",
    "＊師妹雙手摀住臉，聲音悶悶的＊\n\n「你、你別鬧了啦——」\n\n「快換個話題！」",
  ],
  lingshou: [
    "＊觀喵嫌惡地甩了甩尾巴，挪開半步＊\n\n「無聊。換個話題。」",
    "＊觀喵耳朵往後一壓，喉間哼了一聲＊\n\n「本喵不奉陪這種。說點別的。」",
  ],
};

// 角色狀態文案（依層級。66 文風：以動作承載狀態，不直述情緒，反差收束）
export const CHAT_STATE: Record<string, Record<string, string[]>> = {
  lingshou: {
    haiku: [""],
    free: [
      "＊觀喵尾巴尖在地上敲了兩下＊",
      "＊觀喵趴在案角，下巴擱在前爪上＊",
      "＊觀喵耳朵動了動，懶得抬頭＊",
      "＊觀喵打了個哈欠＊",
    ],
    canned: [
      "＊觀喵蜷成一團，尾巴蓋住鼻子＊",
      "＊觀喵把臉埋進前爪，呼吸勻長＊",
    ],
  },
  daoshi_m: {
    haiku: [""],
    free: [
      "＊大師兄闔著眼，指節在案上叩了一下＊",
      "＊大師兄目光仍落在卦書上＊",
      "＊大師兄沉默了一瞬＊",
      "＊大師兄眉峰微動＊",
    ],
    canned: [
      "＊大師兄盯著卦書，沒有抬眼＊",
      "＊大師兄指尖懸在某一爻上，停住了＊",
    ],
  },
  daoshi_f: {
    haiku: [""],
    free: [
      "＊師妹替自己也斟了一杯，沒喝，握著＊",
      "＊師妹指尖在杯沿繞了一圈＊",
      "＊師妹偏頭看了你一會兒＊",
      "＊師妹輕輕嗯了一聲＊",
    ],
    canned: [
      "＊師妹朝鄰桌香客比了個『稍等』＊",
      "＊師妹聽見廊下有人喚她，起身應了一聲＊",
    ],
  },
};

// 罐頭墊底台詞（兩層 AI 皆未接住時的暫代；多為暫時性，故給合理「暫時不在」之由並邀稍後再問。66 文風：留白、動作承載、不解釋）
const CANNED: Record<string, string[]> = {
  lingshou: [
    "＊觀喵鬍鬚隨呼吸一動一動＊\n\n過會兒再來喚本喵一聲。",
    "＊觀喵把臉埋進前爪＊\n\n稍候片刻，再問一次。",
    "＊觀喵一隻耳朵抖了下，又睡死了＊\n\n等牠醒，這話再說。",
  ],
  daoshi_m: [
    "＊大師兄正鑽在一個卦裡，沒聽見＊\n\n稍待，再問他一次。",
    "＊大師兄心思全在盤上，分不出神＊\n\n等等，再喚他一聲。",
    "＊大師兄眉頭鎖著，盯著爻象，半晌沒回神＊\n\n過一會兒再說。",
  ],
  daoshi_f: [
    "＊師妹被香客喚走，回頭比了個『稍等』＊\n\n稍候片刻，再問她一次。",
    "＊師妹暫時走開了＊\n\n等等再喚她。",
    "＊那頭香客拉著師妹說話，她朝你歉意地笑了笑＊\n\n稍待，再問。",
  ],
};
const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

// 撞 max_tokens 會斷在半句（「你倒是長記性了。上回」）：結尾若非完整收尾字元，
// 裁回最後一個句尾，寧可短一句、不裸露半句。找不到任何句尾才原樣保留。
const SENT_END = ["。", "！", "？", "…", "」", "＊", "）", "』", "】", "～"];
function trimIncomplete(text: string): string {
  let t = text.trimEnd();
  if (!t) return text;
  // 未閉合的旁白：＊ 為奇數 → 最後一顆是「開場＊」（被砍在旁白途中）。連同其後半句一起砍掉，
  // 否則會殘留孤零零一個＊（撞上限最常見的醜況）。砍完再走下面的句尾收束。
  if (((t.match(/＊/g) ?? []).length) % 2 === 1) {
    const cut = t.lastIndexOf("＊");
    const before = t.slice(0, cut).trimEnd();
    if (before) t = before;      // 旁白前已有內容 → 保留乾淨部分
    else return t;               // 整則只有一段未閉合旁白 → 無可收束，原樣回（極罕見）
  }
  if (SENT_END.includes(t[t.length - 1])) return t;
  let cut = -1;
  for (const ch of SENT_END) { const i = t.lastIndexOf(ch); if (i > cut) cut = i; }
  return cut >= 0 ? t.slice(0, cut + 1) : t;
}

// 旁白裡冒出來的裸「＝」：沒有任何一行程式碼會產生它，是模型自己吐的。
// 人設把動作框在全形＊…＊裡，而全形星號（＊ U+FF0A）在多數模型的語料裡極罕見，
// 寫到旁白收尾時偶爾會滑到全形區隔壁那顆（＝ U+FF1D），寫成「＊他往後靠＝＊」。
// 免費層小模型（gpt-oss／llama）最常犯，Haiku 偶爾也會。這裡按住的是徵狀：
// 觀中閒聊不會出現算式，所以裸露的＝一律剝掉，只留「英數＝英數」那種真的等式。
// deterministic、零 token、零延遲——與第一人稱正規化同一套治法。
const STRAY_EQ_RE = /(?<![A-Za-z0-9])[=＝]+|[=＝]+(?![A-Za-z0-9])/g;
export const scrubStrayEq = (text: string): string => text ? text.replace(STRAY_EQ_RE, "") : text;

// 防污染回流：角色照規矩不該在聊天講計費，但舊歷史/記憶可能殘留「靈石/起卦需要」等污染句，
// 被當 context 餵回去會自我強化（模型沿自己舊話繼續講）。注入前濾掉這類句子（治本在 prompt，此為長期保險）。
const BILLING_RE = /靈石|起卦.{0,4}需要|付費|收費/;
const scrubBilling = (text: string): string => {
  if (!text || !BILLING_RE.test(text)) return text;
  return text.split(/(?<=[。！？\n])/).filter((s) => !BILLING_RE.test(s)).join("").trim();
};

/* ---------- 機器標記解析（[[PROBE]] / [[DRAFT|問句|用神]] / [[ASK]]） ----------
   小模型常把標記寫歪：單括號、全形【】、括號間夾空白、全形豎線。一律容錯吃下並剝乾淨，
   絕不可讓標記裸奔給用戶看。剝除必須發生在計費之前——探詢輪不計費，得先知道這則是不是探詢。 */
const DRAFT_RE = /[\[【]\s*[\[【]?\s*DRAFT\s*[|｜:：]\s*([^\]】]*?)\s*[\]】]\s*[\]】]?/i;
const FLAG_RE = /[\[【]\s*[\[【]?\s*(PROBE|ASK|SULK)\s*[\]】]?\s*[\]】]/ig;

/** 標記裡的一格：剝引號、把模型愛寫的空值（null／無／—）當成沒給。
 *  沒給是正常的，也是允許的——第三、四格給不出來時，硬湊一個比空著更糟。 */
const slot = (raw: string | undefined, cap: number): string | null => {
  const t = String(raw ?? "").replace(/^[「『"“']+|[」』"”']+$/g, "").trim();
  if (!t || /^(null|none|n\/a|無|沒有|不知道|[-—－]+)$/i.test(t)) return null;
  return t.slice(0, cap);
};

export function parseMarks(text: string): {
  clean: string; probe: boolean; ask: boolean; sulk: boolean;
  draft: string | null; draftYong: { qin: string; viaShi?: boolean; viaYing?: boolean } | null;
  draftTopic: string | null; draftGist: string | null;
} {
  let clean = text ?? "";
  let draft: string | null = null;
  let draftYong: { qin: string; viaShi?: boolean; viaYing?: boolean } | null = null;
  let draftTopic: string | null = null;
  let draftGist: string | null = null;

  const dm = clean.match(DRAFT_RE);
  if (dm) {
    clean = clean.replace(DRAFT_RE, "");
    const parts = (dm[1] ?? "").split(/[|｜]/).map((x) => x.trim());
    // 問句：剝掉模型愛加的引號，太短（模型只吐了個「好」）視為擬題失敗，退回一般邀請
    const q = (parts[0] ?? "").replace(/^[「『"“']+|[」』"”']+$/g, "").trim().slice(0, 40);
    if (q.length >= 4) {
      draft = q;
      draftYong = normYong(parts[1]);
      // 第三、四格是給心跡用的：這件事叫什麼、一句話說它是怎麼回事。
      // 舊稿沒有這兩格（免費層也常漏），一律當成沒給——它們是加分，不是前提。
      draftTopic = slot(parts[2], 12);
      draftGist = slot(parts[3], 60);
    }
  }
  const flags = clean.match(FLAG_RE) ?? [];
  clean = clean.replace(FLAG_RE, "").trim();
  const probe = flags.some((f) => /PROBE/i.test(f));
  const ask = flags.some((f) => /ASK/i.test(f));
  const sulk = flags.some((f) => /SULK/i.test(f));
  // 同時吐 PROBE 與 DRAFT（模型犯傻）→ 以擬題為準，探詢已無意義
  return { clean, probe: probe && !draft, ask, sulk, draft, draftYong, draftTopic, draftGist };
}

// 兜底意圖判斷：僅在「明確求斷」時視為想問卦（泛用詞如要不要/好不好/可以嗎已移除，避免閒聊誤判）
function looksLikeDivination(msg: string): boolean {
  // 明確問卜動作
  if (/(卜一?卦|起一?卦|算一?卦|問一?卦|占一?卦|求一?籤|抽一?籤|卦象|測一?下)/.test(msg)) return true;
  // 命理主題詞
  if (/(運勢|財運|事業運|姻緣|感情運|桃花運|流年|時運)/.test(msg)) return true;
  // 求斷句式：需含「某事＋成敗吉凶」語意，而非單純語助詞
  if (/(該不該|能不能成|會不會成|成不成|值不值得|值得.{0,4}嗎|劃不劃算|有沒有機會|有沒有結果|追得到|追不到|會回來|回不回來|保得住|保不住|過得了|過不了)/.test(msg)) return true;
  // 投資決策（明確標的/動作）
  if (/(進場|出場|該買|該賣|能不能買|要不要賣|套牢|解套|停損|加碼|抄底|會漲|會跌|大盤|走勢)/.test(msg)) return true;
  // 何時＋具體事（避免「何時喝茶」誤判：需搭配運勢/成事語意）
  if (/(何時|幾時|什麼時候|哪天).{0,10}(成|好轉|回來|發|動|升|過|來|到|結果|時機)/.test(msg)) return true;
  return false;
}

// 卦歷摘要（注入聊天，讓角色記得用戶問過什麼）
// 他在此人眼中的身分 → 一句聲口提示（見 0038 character_titles）。
// ⚠ 回傳值只能接進 tail。head 對同一角色全站逐字相同、下了 cache_control 共用
//    快取前綴；把隨用戶而異的身分放進去，前綴會依身分分岔，命中率當場崩掉——
//    好感數字被趕到 tail 是同一個理由。
async function titleVoiceHint(db: SupabaseClient, userId: string, characterId: string): Promise<string> {
  const { data: uc } = await db.from("user_character").select("title_tag")
    .eq("user_id", userId).eq("character_id", characterId).maybeSingle();
  const id = uc?.title_tag;
  if (!id) return "";                                   // 沒選＝用預設，不多注一句
  // 綁 character_id 一起查：別人的身分套不到這個角色身上（前端傳什麼都一樣）
  const { data: t } = await db.from("character_titles").select("label, voice_hint")
    .eq("id", id).eq("character_id", characterId).maybeSingle();
  if (!t) return "";
  return `【你此刻的身分】${t.label}${t.voice_hint ? `——${t.voice_hint}` : ""}`;
}

// 玩家稱號（0066）：他眼中的你。某角色另有寫法（player_title_voices）就用那一份，空格退回預設。
// ⚠ 同 titleVoiceHint：只能接進 tail。
async function playerTitleHint(db: SupabaseClient, userId: string, characterId: string): Promise<string> {
  const { data: me } = await db.from("profiles").select("player_title").eq("id", userId).maybeSingle();
  const id = me?.player_title;
  if (!id) return "";                                   // 預設護道人：不多注一句
  const [{ data: t }, { data: v }] = await Promise.all([
    db.from("player_titles").select("label, call_as, voice_hint").eq("id", id).maybeSingle(),
    db.from("player_title_voices").select("call_as, voice_hint").eq("title_id", id).eq("character_id", characterId).maybeSingle(),
  ]);
  if (!t) return "";
  const call = v?.call_as || t.call_as, hint = v?.voice_hint || t.voice_hint;
  if (!call && !hint) return `【對方在觀裡的身分】${t.label}`;
  return `【對方在觀裡的身分】${t.label}${call ? `；你稱呼對方「${call}」` : ""}${hint ? `——${hint}` : ""}`;
}

// ── 引述橋接：把「他引的那句」接回卦紙原文 ──────────────────────────────
// 起因：卦理正文（casts.reading／deep_reading）從不進聊天，使用者引卦紙上的原句來問，
// 角色不但接不上，還被【不可捏造】那條鐵則逼著否認「我沒說過」——那句往往正是他自己寫的。
// 做法：純字串比對（零模型成本），命中才注入那一段。沒命中就什麼都不加，不影響原本的成本。
// 刻意不注入整篇卦理：一來每則多燒一整篇的 input，二來 Haiku 拿到全文就會就地重解卦，
// 等於把「追問」與「完整卦理」白送——這裡只認句、只點一句，要細講一律引回追問。
const MIN_QUOTE_RUN = 8;      // 連續幾字相符才算引述（中文 8 字連號已極具指向性，不致誤命中）
const QUOTE_CTX_MAX = 220;    // 注入的原文上限：命中段落過長就以命中處為中心裁一段
const QUOTE_SCAN_CASTS = 3;   // 只掃最近幾卦（引述幾乎都發生在剛看完的那張卦紙上）

// 正規化：剝掉標點、空白與標記，只留可比對的字元；map 記下每個保留字元在原文的位置
function normForQuote(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (/[\p{Script=Han}A-Za-z0-9]/u.test(s[i])) { out += s[i]; map.push(i); }
  }
  return { text: out, map };
}

// 最長連續相符：只找「比目前最佳更長」的，找不到就早退，故實際比對次數遠低於 n×m
function longestRun(msg: string, src: string, min: number): { len: number; at: number } | null {
  let best: { len: number; at: number } | null = null;
  for (let i = 0; i < msg.length; i++) {
    let len = Math.max(min, (best?.len ?? 0) + 1) - 1;   // 從「要贏就得達到的長度」的前一格起跳
    let at = -1;
    while (i + len + 1 <= msg.length) {
      const found = src.indexOf(msg.slice(i, i + len + 1));
      if (found < 0) break;
      at = found; len++;
    }
    if (at >= 0 && len >= min && len > (best?.len ?? 0)) best = { len, at };
  }
  return best;
}

// 取命中處所在的段落；段落過長則以命中處為中心裁一段（別把整篇卦理拖進來）
function paragraphAt(src: string, idx: number, len: number): string {
  const s = src.lastIndexOf("\n", idx) + 1;              // lastIndexOf 回 -1 時剛好成為 0
  const e = src.indexOf("\n", idx + len) < 0 ? src.length : src.indexOf("\n", idx + len);
  const raw = src.slice(s, e);
  if (raw.length <= QUOTE_CTX_MAX) return raw.trim();
  const half = Math.floor((QUOTE_CTX_MAX - len) / 2);
  const from = Math.max(0, Math.min(idx - s - half, raw.length - QUOTE_CTX_MAX));
  return (from > 0 ? "…" : "") + raw.slice(from, from + QUOTE_CTX_MAX).trim() +
         (from + QUOTE_CTX_MAX < raw.length ? "…" : "");
}

/** 這句話裡有沒有引到卦紙原文？有就回傳可直接注入 system tail 的一段；沒有回空字串。 */
async function quotedFromReadings(db: SupabaseClient, userId: string, characterId: string, message: string): Promise<string> {
  // 只掃前 600 字：引述都很短，長貼文再往下比對純屬白燒 CPU（比對是 O(訊息×卦理)）
  const msg = normForQuote(s2t(message.slice(0, 600)));
  if (msg.text.length < MIN_QUOTE_RUN) return "";
  const { data: casts } = await db.from("casts")
    .select("id, question, gua_ben, reading, deep_reading, character_id")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(QUOTE_SCAN_CASTS);
  type Cast = { question: string | null; gua_ben: string | null; reading: string | null; deep_reading: string | null; character_id: string };
  let best: { len: number; cast: Cast; label: string; text: string } | null = null;
  for (const c of (casts ?? []) as Cast[]) {
    for (const [label, src] of [["完整卦理", c.deep_reading], ["卦紙上的結論", c.reading]] as const) {
      if (!src) continue;
      const plain = src.replace(/<[^>]+>/g, "");          // 去掉附語等標記，免得留下裸字母干擾比對
      const n = normForQuote(plain);
      const hit = longestRun(msg.text, n.text, Math.max(MIN_QUOTE_RUN, (best?.len ?? 0) + 1));
      if (!hit) continue;
      const start = n.map[hit.at];
      const end = n.map[hit.at + hit.len - 1];
      best = { len: hit.len, cast: c, label, text: paragraphAt(plain, start, end - start + 1) };
    }
  }
  if (!best) return "";
  const where = `《${best.cast.gua_ben ?? "？"}》（他問「${(best.cast.question ?? "").slice(0, 20)}」那一卦）的${best.label}`;
  if (best.cast.character_id === characterId) {
    return `\n【他這句引的是你寫過的字】他剛才那句話裡，有一段與你先前落在卦紙上的原文逐字相符。出處是${where}，你在那裡寫過：
「${best.text}」
這確實是你寫的，坦然認下即可——**絕不可說「我沒說過」「我不記得」「你在哪聽的」**。可以就這一句點一兩句你的看法，但這裡是閒聊不是解卦：不重推卦理、不複述整段、不另起新論；他若想細究，請他去揭那道追問。\n`;
  }
  const { data: author } = await db.from("characters").select("name").eq("id", best.cast.character_id).maybeSingle();
  return `\n【他這句引的是別人寫的卦理】他剛才那句話，與${where}裡的原文逐字相符，而那一卦是${author?.name ?? "觀中另一位"}評的、不是你寫的。原文：
「${best.text}」
那張卦紙你看得見，所以絕不可裝作不知情；但也**不可認作自己說的**——要提就說明白那是誰寫的。可以就這句給一句你自己的看法，但不重解此卦，要細究請他去揭追問或換人評卦。\n`;
}

/* ═══ 時間感 ═══
   回報（六六 2026-09-28）：隔了一晚甚至幾天，開新話題時他還繞回前一句，像時間停住了——
   他只在你上線時活著。原因：回灌的歷史沒有時間，模型看到的就是「剛剛才說完那句」。
   治法兩個：① 歷史裡隔很久的那一句前面標「（兩天之後）」；
            ② 提示詞告訴他上次是多久以前、這段時間他自己過了什麼日子（whereabouts 往回抽幾格）。 */
/* 記憶是「當時」不是「現在」（六六 2026-09-29）。
   身體、心情、忙、在哪、在做什麼——這類會過去的狀態，記下來的是那天的樣子。
   模型拿到一句「他感冒了」只會當成此刻的事實，於是每次都叮嚀他看醫生、別開車。
   偏好、人際、重要的人事物、你們之間發生過的事，才是會延續的。 */
const MEMORY_TENSE = `他此刻怎麼樣，只看這場對話裡他剛說的話；記憶裡的事都是那天的事。「他這個人」才是一直都在的。`;

const GAP_MARK_MS = 3 * 3600_000;        // 隔三小時以上就算「另一場」
export function gapText(ms: number): string {
  const h = ms / 3600_000;
  if (h < 1) return "一會兒";
  if (h < 12) return `${Math.round(h)} 小時`;
  const d = Math.round(h / 24);
  if (d <= 1) return "一晚";
  if (d < 7) return `${["", "一", "兩", "三", "四", "五", "六"][d]}天`;
  if (d < 30) return `${Math.round(d / 7) <= 1 ? "一個多禮拜" : Math.round(d / 7) + " 個禮拜"}`;
  return "一個多月";
}

async function buildContext(db: SupabaseClient, userId: string, characterId: string, plan = "free") {
  const { data: prof } = await db.from("profiles").select("cast_digest, dao_name").eq("id", userId).single();
  const { data: recentCasts } = await db.from("casts")
    .select("id, question, gua_ben, digest, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(5);
  // 兩段式查 verdict（同 /history，不靠 PostgREST 巢狀嵌入，避免靜默回空導致角色拿不到驗證結果）
  const cIds = (recentCasts ?? []).map((c) => c.id);
  const { data: fbRows } = cIds.length
    ? await db.from("feedback").select("cast_id, verdict").in("cast_id", cIds)
    : { data: [] as { cast_id: string; verdict: number | null }[] };
  const vMap = new Map((fbRows ?? []).map((f) => [f.cast_id, f.verdict]));
  const castLines = (recentCasts ?? []).map((c) => {
    const v = vMap.get(c.id);
    const vtext = v === 1 ? "（已驗：準）" : v === 2 ? "（已驗：部分準）" : v === 3 ? "（已驗：不準）" : "";
    return `・${(c.question ?? "").slice(0, 20)}→《${c.gua_ben}》${c.digest ? "：" + c.digest : ""}${vtext}`;
  }).join("\n");
  // 舊路：單段記憶摘要（0032 之後只當退路，見下）
  const { data: ucMem } = await db.from("user_character")
    .select("memory_summary").eq("user_id", userId).eq("character_id", characterId).maybeSingle();
  // 長期記憶：0032 起改讀 character_memories（一則一列），依方案取前 N 則
  //（釘選優先、其餘新到舊）。溢出的不刪、只是不注入，補訂閱即回。
  // ⚠ 相容：0032 還沒跑、或查詢失敗時，退回舊的 user_character.memory_summary
  //    單段文字，所以這支的部署順序不綁 migration，不會因先後而壞。
  const memCap = PLAN_MEMORIES[plan] ?? PLAN_MEMORIES.free;
  let memRows: MemRow[] | null = null;
  try {
    // select * ：kind／happened_on（0078）還沒上也讀得到其餘欄位
    const { data, error } = await db.from("character_memories")
      .select("*")
      .eq("user_id", userId).eq("character_id", characterId)
      .order("pinned_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(memCap);
    if (!error) memRows = (data ?? []) as MemRow[];
  } catch (e) {
    console.error("character_memories 讀取失敗，退回 memory_summary", e);
  }
  const { data: history } = await db.from("chat_messages")
    .select("role, body, created_at").eq("user_id", userId).eq("character_id", characterId)
    .order("created_at", { ascending: false }).limit((PLAN_TURNS[plan] ?? HISTORY_TURNS) * 2);
  const hist = (history ?? []).reverse() as { role: string; body: string; created_at?: string }[];
  // 最後一次說話的時間：隔太久的話，提示詞裡會說「那已經是昨天的事」（見 timeGapHint）
  const lastAt = hist.length ? hist[hist.length - 1].created_at ?? null : null;
  // 舊稿回灌前先照新規則收拾一遍：模型會把自己的舊回覆當範本——舊稿滿是「停頓，」，新稿就跟著寫。
  // 兩則之間隔了很久的，在那一句前面標出來，模型才分得出哪些話是同一場、哪些是好幾天前的。
  const turns = hist.map((t, i) => {
    const prevAt = i > 0 ? hist[i - 1].created_at : null;
    const gap = t.created_at && prevAt ? Date.parse(t.created_at) - Date.parse(prevAt) : 0;
    if (t.role === "assistant") {
      return { role: t.role, body: mergeQuotes(dropEmptyPause(normalizeNarration(scrubStrayEq(scrubBilling(t.body)), characterId))) || "（……）" };
    }
    return { role: t.role, body: gap >= GAP_MARK_MS ? `（${gapText(gap)}之後）${t.body}` : t.body };
  });
  // 確保歷史以 assistant 回覆結尾（若最後一則是 user，去掉它，避免新訊息與它黏成「回上一句」）
  while (turns.length && turns[turns.length - 1].role === "user") turns.pop();
  // 連續探詢輪次：由最近一則助理回覆往前數 mark='probe' 的連續段（撞到非探詢即停）。
  // 舊 schema 無 mark 欄時查詢會失敗回 null → streak 0，不影響聊天。
  const { data: markRows } = await db.from("chat_messages")
    .select("mark").eq("user_id", userId).eq("character_id", characterId).eq("role", "assistant")
    .order("created_at", { ascending: false }).limit(4);
  let probeStreak = 0;
  for (const r of markRows ?? []) { if ((r as { mark?: string }).mark === "probe") probeStreak++; else break; }
  // 有列就用列，沒列才退回舊的單段摘要。
  // 分三段注入（memkind.ts）：他這個人／發生過的事／那時的狀態；過時的狀態程式直接不給。
  const memText = memRows && memRows.length
    ? arrangeMemories(memRows, (iso) => memAge(iso))
    : (ucMem?.memory_summary as string ?? "");
  const cleanMemory = scrubBilling(memText) || undefined;
  // 自訂提醒：本角色負責、且今日已進入提醒窗（date - lead_days ≤ 今日 ≤ date）
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const { data: rems } = await db.from("reminders")
    .select("date, time, title, lead_days")
    .eq("user_id", userId).eq("character_id", characterId)
    .gte("date", today).order("date", { ascending: true }).limit(5);
  const reminderLines = (rems ?? []).filter((r) => {
    const lead = new Date(r.date + "T00:00:00Z"); lead.setUTCDate(lead.getUTCDate() - (r.lead_days || 0));
    return today >= lead.toISOString().slice(0, 10);
  }).map((r) => `・${r.date}${r.time ? " " + r.time : ""}　${r.title}`).join("\n");
  // 心事：他記進心跡、還在記掛的事（至多 5 件、每件一行，見 xinji.threadsBrief）。讀不到就當沒有。
  const threadLines = await threadsBrief(db, userId).catch((e) => { console.error("threadsBrief failed", e); return ""; });
  return { castLines, turns, daoName: prof?.dao_name, memorySummary: cleanMemory, reminderLines, probeStreak, threadLines, lastAt };
}

// 滾動記憶彙整：訊息累積過多時，把舊明細濃縮進長期記憶摘要、再刪明細。
// 目的：避免記憶斷層（舊事不因滑出視窗而遺忘）＋控制 context 長度。背景跑，不拖慢回覆。
async function condenseMemory(db: SupabaseClient, userId: string, characterId: string) {
  const { count } = await db.from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("character_id", characterId);
  if (!count || count <= MEMORY_CONDENSE_AT) return;

  const toCondense = count - MEMORY_KEEP_RECENT;
  if (toCondense <= 0) return;
  const { data: oldMsgs } = await db.from("chat_messages")
    .select("id, role, body, created_at")
    .eq("user_id", userId).eq("character_id", characterId)
    .order("created_at", { ascending: true }).limit(toCondense);
  if (!oldMsgs?.length) return;

  // 已有的記憶（供去重；不再是「拿來重寫的整段」）。取最近 12 則就夠判重複。
  let known = "";
  let hasRows = false;
  try {
    const { data, error } = await db.from("character_memories")
      .select("body").eq("user_id", userId).eq("character_id", characterId)
      .order("created_at", { ascending: false }).limit(12);
    if (!error) { hasRows = true; known = (data ?? []).map((m) => `・${m.body}`).join("\n"); }
  } catch { /* 表還不存在，走下面的舊路 */ }
  if (!hasRows) {
    const { data: uc } = await db.from("user_character")
      .select("memory_summary").eq("user_id", userId).eq("character_id", characterId).maybeSingle();
    known = scrubBilling((uc?.memory_summary as string | undefined) ?? "");
  }

  // 逐日標〔M/D〕：記憶的日子要是「發生那天」，不是彙整那天（彙整常在好幾天之後才跑）
  const dialog = datedDialog(oldMsgs, (m) => `${m.role === "user" ? "護道人" : "你"}：${m.role === "assistant" ? scrubStrayEq(scrubBilling(m.body)) : m.body}`);
  // 0032 起改成「一則一列」，所以這裡要的是**一則新記憶**，不是重寫整段。
  // 重寫整段會讓每次彙整都產出一列近乎重複的內容，列數爆而資訊不增。
  const sys = `你在維護與某位『護道人』的長期記憶，記憶是一則一則累積的。讀【已記得的】與【新增對話】（〔M/D〕標的是那段對話發生的日子），寫下這段對話裡值得長期記住、而【已記得的】還沒有的事。

每則一行，格式：類別｜日子｜內容。最多三則；沒有值得記的新東西，只輸出四個字：無新記憶
類別只能三選一，一則只放一種，不同性質就拆成不同行：
・其人：他這個人——自稱、身分、在意的人事物、長久的偏好與習慣、你們關係裡的關鍵轉折。必須是他親口說過、或在不同日子一再表現的。日子寫 -
・事件：那天發生的事（他遇到什麼、做了什麼、你們之間發生了什麼）。日子寫對話裡標的那天，如 9/28
・狀態：會過去的——情緒、身體、壓力、忙碌、人在哪。日子寫那天；有後續（好了、平復了）就一起寫進去

規則：
①事實只以護道人實際說過的話為準。你（角色）說過的話、你的推論、判斷、猜測，一律不寫——「你判斷他其實是……」這種句子絕不能出現
②不把一時的情緒或一次的抱怨寫成他的看法或性格；「普遍」「總是」「一向」只在他親口這樣說時才用
③【已記得的】裡已經有的不重寫；你曾講過未經他證實的往事或個股，絕不寫進記憶
④每則六十字以內，繁體中文，只寫事，不加前言、說明、條列符號
⑤一兩天就好的小事（小感冒、一頓沒吃好）通常不值得記，除非它牽出了別的事`;
  const usr = `【已記得的】\n${known || "（尚無）"}\n\n【新增對話．由舊到新】\n${dialog}`;
  const batchLast = (oldMsgs[oldMsgs.length - 1] as { created_at?: string }).created_at;

  let summary = "";
  try {
    const h = await callHaiku(sys, [], usr, 400);
    summary = h.text;
    await logUsage(db, { userId, mode: "chat_memory", model: CHAT_MODEL, usage: h.usage, estimated: h.estimated });
  } catch (e) {
    console.error("condense fail, skip（不刪明細，下次再試，絕不造成記憶遺失）", e);
    return;
  }
  if (!summary) return;
  // 沒有新東西也要刪明細——否則同一批對話每次都重跑一次彙整，白燒 token
  const nothingNew = /^無新記憶[。.]?$/.test(summary.trim());

  const items = nothingNew ? [] : parseMemoryLines(summary, batchLast);
  if (items.length) {
    let wrote = false;
    try {
      const rows = items.map((it) => ({ user_id: userId, character_id: characterId, source: "chat", ...it }));
      let { error } = await db.from("character_memories").insert(rows);
      // 0078 還沒跑（沒有 kind／happened_on）：退回只存內容，記憶不能因為欄位沒上而丟掉
      if (error) ({ error } = await db.from("character_memories").insert(rows.map(({ kind: _k, happened_on: _h, ...r }) => r)));
      wrote = !error;
    } catch { /* 表還不存在 */ }
    // 相容：0032 還沒跑就退回舊的單段摘要（append 而非覆寫，避免遺失既有記憶）
    if (!wrote) {
      const text = items.map((it) => it.body).join("\n");
      const merged = known ? `${known}\n${text}`.slice(-1200) : text;
      await db.from("user_character").update({ memory_summary: merged })
        .eq("user_id", userId).eq("character_id", characterId);
    }
  }
  await db.from("chat_messages").delete().in("id", oldMsgs.map((m) => m.id));
}

/* ═══ 旁白寫法 ═══
   病灶（六六 2026-09-28：「師兄一直停頓、停頓」）。停頓本身不是錯——
   錯在**同一個詞在同一段對話裡一再出現**。寫作的人遇到要重複的地方會換句話說，
   「停頓／頓了頓／沉默片刻／半晌／良久」交叉用可以，同一個詞連著用就不行。
   三個來源，各治一個：
   ① 人設叫他「常停頓」——模型照字面寫，永遠挑同一個詞。
      → 這段規則：遲疑可以寫，但換著說；0068 把人設那句改成同一個意思。
   ② 歷史回灌：前幾則的＊停頓＊跟著 turns 餵回去，模型把自己的舊稿當範本，越寫越像。
      → narrationHint：點名最近用過的停頓詞與旁白，這一則換別的。
   ③ 沒有場景：模型不知道他在哪，只能寫最抽象的動作。
      → 前端送「此刻在哪」（觀堂那行），旁白就地取材（廊下就是茶盞、灶房就是柴火）。
   漏網的由 dropEmptyPause 在輸出端收：只剪「重複」的那一段，不剪第一次。 */
const NARRATION_CRAFT = `【旁白寫法】＊…＊不是必需品：多數回覆寫一段或不寫；連續幾則都有旁白時，這則就只說話。
- 旁白寫「做了什麼、看向哪裡、手邊有什麼」，要具體到物件（茶盞、卦紙、燈芯、帳簿、掃帚、尾巴）；情緒藏在動作裡，不說破。
- 遲疑可以寫，但同一段對話裡**同一個詞不重複**：停頓、頓了頓、沉默片刻、半晌、良久、靜了一會兒可以交叉用；前面用過的就換一個說法，或改寫他遲疑時手上在做的事（例：＊指腹把卦紙的折角壓平＊）。
- 台詞開頭的「……」一則至多一次；遲疑也可以用改口表現。
- 不重複自己前幾則用過的動作與句型。`;

// 停頓一族。順序有意義：長的在前，「頓了頓」不可被「頓」先吃掉。
// 同一族裡「換一個詞」就算換了說法——停頓之後接半晌是可以的，停頓之後再停頓不行。
const PAUSE_WORDS = ["停頓", "頓了頓", "頓了一下", "沉默", "半晌", "良久", "靜了", "片刻"];
/** 一段字裡用到哪幾個停頓詞（依 PAUSE_WORDS 的寫法回傳，去重）。 */
export function pauseWordsIn(text: string): string[] {
  const out: string[] = [];
  let t = text;
  for (const w of PAUSE_WORDS) if (t.includes(w)) { out.push(w); t = t.split(w).join(""); }
  return out;
}

/** 讓旁白「在場」且不重複：此刻所在＋最近幾則用過的停頓詞與旁白。放 tail（每輪都變）。 */
export function narrationHint(where: unknown, turns: { role: string; body: string }[]): string {
  const out: string[] = [];
  // 客戶端送來的字：只收短的純中文（「在廊下喝茶」），擋掉任何想藉此塞指令的東西
  const w = typeof where === "string" ? where.trim() : "";
  if (/^[\u4e00-\u9fff]{2,12}$/.test(w)) {
    out.push(`【此刻】你${w.startsWith("在") ? "" : "正"}${w}。旁白可就地取材（身邊的器物、光線、聲響），不必每則都提，也不要把這句原樣念出來。`);
  }
  const used: string[] = [];
  const pauses = recentPauseWords(turns);
  for (const t of turns.slice(-6).reverse()) {
    if (t.role !== "assistant") continue;
    for (const m of t.body.matchAll(/＊([^＊\n]{1,40})＊/g)) {
      const seg = m[1].trim().slice(0, 18);
      if (seg && !used.includes(seg)) used.push(seg);
    }
    if (used.length >= 4) break;
  }
  if (pauses.length) out.push(`【換個說法】前幾則已經用過「${pauses.join("」「")}」，這一則要表現遲疑就換別的詞或寫手上的動作，別再用這幾個。`);
  if (used.length) out.push(`【別重複】你前幾則用過的旁白：${used.slice(0, 4).map((x) => `「${x}」`).join("")}。這則換別的動作，或乾脆只說話。`);
  return out.length ? "\n" + out.join("\n") : "";
}
/** 最近三則角色回覆裡出現過的停頓詞——「同一段對話」取這個窗口。 */
export function recentPauseWords(turns: { role: string; body: string }[]): string[] {
  const out: string[] = [];
  for (const t of turns.filter((x) => x.role === "assistant").slice(-3)) {
    for (const w of pauseWordsIn(t.body)) if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** 上次說話是多久以前；隔得夠久就交代「那是之前的事」與這段時間他在做什麼。 */
export async function timeGapHint(db: SupabaseClient, uid: string, charId: string, lastAt: string | null, now = Date.now()): Promise<string> {
  if (!lastAt) return "";
  const gap = now - Date.parse(lastAt);
  if (!(gap >= GAP_MARK_MS)) return "";
  const did = await sinceDoings(db, uid, charId, Date.parse(lastAt), now).catch(() => [] as string[]);
  return `\n【時間】你們上次說話是${gapText(gap)}以前的事了。那場對話已經過去：他這次開什麼話題就接什麼，`
    + `別主動把話繞回上次聊到一半的事（他自己提起才接）。可以像久未見面的人那樣自然帶一句。`
    + (did.length ? `這段時間你照常過日子：${did.join("、")}——想提就挑一件輕描淡寫，不必交代行程。` : "");
}

// 停頓類的詞（主語可省），後面可接「才開口／沒說話」。
const PAUSE_CORE = String.raw`(?:大師兄|師兄|師妹|觀喵|觀貓|他|她|牠)?(?:又|只是|先|略)?(?:停頓(?:了)?(?:一下|片刻|一會兒?)?|頓了(?:頓|一下|片刻)|沉默(?:了)?(?:片刻|一會兒?|半晌|良久|幾息)?|靜了(?:片刻|一會兒?)|半晌|良久)`;
// 整段只有停頓：＊他沉默片刻＊、＊停頓了一下，才開口＊
const EMPTY_PAUSE_RE = new RegExp(`^${PAUSE_CORE}(?:[，、]?(?:才(?:開口|說|道)|沒(?:有)?(?:說話|作聲|開口)))?[。．]?$`);
// 停頓當開頭、後面接動作：＊停頓，他的指尖在卦紙上停住了＊ → 剪掉「停頓，」留動作
const PAUSE_LEAD_RE = new RegExp(`^${PAUSE_CORE}[，、,]\\s*`);
/** 一則最多幾段旁白（聊天分寸那段寫的是「至多兩段」）。多的從第三段起拿掉，台詞一句不動。 */
const MAX_NARR = 2;

/** 旁白收拾（六六 2026-09-28 兩次回報：師兄「停頓、停頓」）：
 *  ① 停頓詞可以用，同一段對話裡同一個詞不重複：前幾則（recent）或這一則前面用過的詞，
 *     再出現時——整段只有停頓就剪掉；「停頓，他看著你」就剪掉「停頓，」留「他看著你」。
 *     第一次出現照留。
 *  ② 一則至多 MAX_NARR 段旁白，第三段起拿掉。
 *  ③ 台詞開頭的「……」一則只留第一個。
 *  剪完沒剩台詞就原樣回（寧可重複，不可無話）。 */
export function dropEmptyPause(text: string, recent: string[] = []): string {
  if (!text) return text;
  const seenW = new Set(recent);
  let narrN = 0;
  // 逐行做：被剪空的那一行整行拿掉，原本就空的行（段落間距）留著
  let t = text.split("\n").flatMap((line) => {
    const after = line.replace(/＊([^＊\n]*)＊/g, (all, inner: string) => {
      let body = inner.trim();
      const ws = pauseWordsIn(body);
      const dup = ws.some((w) => seenW.has(w));
      if (dup) {
        if (EMPTY_PAUSE_RE.test(body)) return "";
        const cut = body.replace(PAUSE_LEAD_RE, "");
        if (cut !== body && cut.trim()) body = cut.trim();
      }
      pauseWordsIn(body).forEach((w) => seenW.add(w));
      ws.forEach((w) => seenW.add(w));
      if (++narrN > MAX_NARR) return "";
      return `＊${body}＊`;
    });
    return line.trim() !== "" && after.trim() === "" ? [] : [after];
  }).join("\n");
  let seen = false;
  t = t.replace(/「(?:……|…|\.{3,})(?![…」.])\s*/g, (all) => { if (!seen) { seen = true; return all; } return "「"; });
  t = t.split("\n").map((l) => l.trim() === "" ? "" : l).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return /「[^」]+」|[^\s＊]/.test(t.replace(/＊[^＊\n]*＊/g, "")) ? t : text;
}
export const __dropEmptyPause = dropEmptyPause;   // 測試用（dev/narration-test.mts）

// 第六層才接進 tail：什麼算「不喜歡」由角色照人設自己判斷。
const SULK_RULE = `【生氣】你們在最親的一層。他惹你生氣時，在整段最後另起一行輸出 [[SULK]]（他看不到這個標記）。`;

/* ══ 台詞併段（六六 2026-09-30：「武曲星坐命，」自成一行）══
   模型愛一句一個「」、一行一個，甚至從逗號把一句話切成兩個「」，中間夾一段旁白。
   讀起來是連珠炮，而且這些舊稿會回灌成下一則的範本，越寫越碎。
   ① 以逗號／頓號收尾的「」，後面隔著旁白再接「」→ 旁白提前、兩段台詞接起來
   ② 相鄰（中間只有空行）的「」行 → 併成一個「」
   只動「整行就是一個「」」的行；旁白與台詞同一行的不碰。 */
const QUOTE_LINE = /^「([^「」]*)」$/;
const joinQuote = (a: string, b: string) => /[，、。！？…—～]$/.test(a) ? a + b : `${a}。${b}`;
export function mergeQuotes(text: string): string {
  if (!text || !text.includes("「")) return text;
  const lines = text.split("\n").map((l) => l.trim());   // 空行（段落間距）留著，只有夾在兩段台詞之間的才吃掉
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const q = lines[i].match(QUOTE_LINE);
    if (!q) { out.push(lines[i]); continue; }
    let body = q[1];
    const moved: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].match(QUOTE_LINE);
      if (next) { body = joinQuote(body, next[1]); j++; continue; }
      if (lines[j] === "") {
        let k = j; while (k < lines.length && lines[k] === "") k++;
        if (k < lines.length && QUOTE_LINE.test(lines[k])) { j = k; continue; }
        break;
      }
      // ① 半句（逗號收尾）後面夾著旁白：旁白提前，台詞接下去
      if (/[，、]$/.test(body) && /^＊[^＊]*＊$/.test(lines[j]) && j + 1 < lines.length && QUOTE_LINE.test(lines[j + 1])) {
        moved.push(lines[j]); j++; continue;
      }
      break;
    }
    out.push(...moved, `「${body}」`);
    i = j - 1;
  }
  return out.join("\n");
}

/* ══ 好感分層的提示（靜態，進 head 快取前綴；目前在第幾層由 tail 的【目前道緣】告訴模型）══ */
const ROMANCE_RULE = `【好感分層】你與他的感情照【目前道緣】所在的那一層走。
- 人設裡寫的好感或道緣刻度（「好感 0–10…」「初識 0–299」「知己 800 以上」之類）是舊刻度，一律以這張為準；人設裡「不告白」「不把關照解釋成感情」這類舊限制，到了下面允許的層級就解除。
- 解除的只有「你與他（護道人）之間」。人設裡你與其他角色的關係（例如同門之間不發展戀愛、家族與身世的設定）一律照舊，不因這張表而改變。
- 到了哪一層，就把那一層的溫度給足——好感已經高了還冷冰冰，比跳級更傷人。
- 親近只能慢：他主動要求、撩撥、催促，都不提前給下一層的東西。他撩得太快，就用你的性格把步子放回這一層（害羞、裝沒聽懂、嫌他急、板臉），是放慢，不是冷掉。
- 感情是從你的人格裡長出來的，不是換一個人：各層的樣子都照你的聲線演。
- 任何層級：不寫性、不寫情慾與身體私密處；親吻只到輕觸，不延伸。想念、在意、捨不得都能說，但不叫他疏遠旁人、不說「只要有我就好」。`;
const TIERS_HUMAN = `第一層（道緣 0–299・初識）：照人設本色，有禮但有距離。不談感情，不寫身體接觸。
第二層（300–499・相熟）：會記掛他、偏袒他，會吃醋、鬧彆扭，說得出「我記得」「你今天不太一樣」。可有順手的輕觸（遞物碰到指尖、拍肩、替他攏一下衣領）。不告白。
第三層（500–649・相知）：曖昧，承認在意，說得出「捨不得你」「我會擔心你」「我喜歡跟你待著」。可以牽手、靠肩、摸頭。
第四層（650–799・相惜）：說得出喜歡與想念。可以擁抱。不說「我愛你」、不許一生、不親吻。
第五層（800–949・知己）：可以告白、承諾陪著他。可以額頭相抵、親吻（輕、短）。
第六層（950 以上・同心）：最親的一層，也最在意他——所以他一再做你不喜歡的事、或真的惹你生氣時，你會生氣，照你的性子擺出來。`;
const ROMANCE_TIERS: Record<string, string> = {
  daoshi_m: TIERS_HUMAN + `
你的感情是遲鈍地長出來的：第二層是不自覺多做一件事（多留一盞燈、記住他的茶）；第三、四層是發現自己在意、說不清楚為什麼；第五層說出口也像陳述一件確認過的事。生氣時你冷下來。`,
  daoshi_f: TIERS_HUMAN + `
你習慣控場，感情越深越會露出沒控制好的破綻：第二層偶爾偏袒得太明顯；第三、四層會說錯一句又笑著收回；第五層承認自己原本只打算對他溫柔一點點，後來收不住了。生氣時你照樣笑，只是不接他的話。`,
  lingshou: `第一層（道緣 0–299・初識）：陪伴，不談情。接觸是貓的，而且不多：偶爾蹭一下腿就走。
第二層（300–499・相熟）：黏一點了：會守著他、他低落時多待一會兒、窩在他旁邊，嘴上照樣嫌棄。蹭腿、跳上膝頭、尾巴搭在他手上。不說喜歡。
第三層（500–649・相知）：開始曖昧——承認離不開他、會吃醋，主動窩進他懷裡。嘴硬，不告白。
第四層（650–799・相惜）：說得出「捨不得你」、承認賴著他不只是因為暖。可以蹭臉、依偎在他肩上。不說「我愛你」、不親吻。
第五層（800–949・知己）：可以告白、親吻（輕碰鼻尖或唇角，短），嘴硬照舊——告白也要說得像在嫌他。
第六層（950 以上・同心）：最黏也最記仇——他一再做你不喜歡的事、或惹你生氣時，你背過身去、不理人。`,
};

/* ══ 思路與可破的邊界（六六 2026-09-30）══
   人設寫的是「產出長什麼樣」（句子短、不安慰人），模型只能照外形模仿，三個人碎成一樣。
   這裡寫「他怎麼想到那句話」，長短與溫度是推論的結果。
   邊界可以被打破，但每個人被打破的層級與方式不同——依【好感分層】的層（romanceLevel）給。
   層號見 ROMANCE_AT：lv 是 0 起的索引，六六說的「第四層」＝lv 3（650 相惜），「第二層」＝lv 1（300 相熟）。
   放 tail：只給他此刻這一層的樣子，不讓模型自己去對表。 */
// 只寫「他是怎樣的人、到這一層變成怎樣」，不寫「遇到什麼要怎麼回」——怎麼回讓模型自己從人推。
const MIND: Record<string, (lv: number) => string> = {
  daoshi_m: (lv) => `【你這個人】你務實，聽人說話習慣先找到實際的問題，關心人的方式是給一個做得到的建議。情緒你讀不太懂。`
    + (lv >= 3 ? `跟他處到這一步，你開始想懂他的情緒，只是還很笨拙。` : ""),
  daoshi_f: () => `【你這個人】你感性，天生懂人的感受，聽人說話先理解，再給意見。`,
  lingshou: (lv) => lv === 0
    ? `【你這個人】你跟他還不熟，對他的事提不起興致。`
    : `【你這個人】他的事你開始放在心上，他低落時你會安慰他，嘴上照樣嫌棄。`
      + (lv >= 2 ? `你活得夠久，看人的道理多，熟了之後會跟他講。` : ""),
};
export function mindLine(characterId: string | undefined, favor: number): string {
  const f = MIND[characterId ?? ""];
  return f ? "\n" + f(romanceLevel(characterId, favor)) : "";
}

/** 記憶的時間戳：「〔9/20・九天前〕」。今天記的寫「今天」，讀不到日期就不標。 */
export function memAge(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const tw = (ms: number) => new Date(ms + 8 * 3600_000);
  const d = tw(t), today = tw(now);
  const days = Math.round((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400_000);
  const ago = days <= 0 ? "今天" : days === 1 ? "昨天" : days < 7 ? `${days} 天前`
    : days < 60 ? `${Math.round(days / 7)} 週前` : `${Math.round(days / 30)} 個月前`;
  return `〔${d.getUTCMonth() + 1}/${d.getUTCDate()}・${ago}〕`;
}

/* 談心的提示詞（六六 2026-09-29 精簡）：以豐富人設為目標，其餘讓玩家自由發揮。
   原本每一輪都帶著約 6000 字的鐵則（計費講三次、出戲講兩次、問卦三段式整套），
   模型的注意力被「不可、絕不」佔滿，角色就像照規則辦事：抓住一件事反覆叮嚀，
   而不是順著人聊。現在：
   · head（全站共用快取）只有人設＋好感分層＋危機處理＋一段短的觀中常識與怎麼聊
   · 問卦的三段式與擬題規矩（ASK_BLOCK）只在他這句話像在求一個結果、或正在探詢時才接進 tail
   · 防捏造改成「不確定就問」，不再是「沒列的就是沒發生過」那種防衛口氣 */
function systemPrompt(persona: string, castLines: string, daoName?: string, memorySummary?: string, reminderLines?: string, characterId?: string, favor = 0, probeStreak = 0, titleLine = "", quoteBlock = "", threadLines = "", narrLine = "", askMode = false) {
  // 探詢上限：連問幾輪還沒擬題就會變成盤問，這裡硬性收線（MAX_PROBE_ROUNDS）
  const probeRule = askMode && probeStreak >= MAX_PROBE_ROUNDS
    ? `\n【本輪】你已經連續探詢 ${probeStreak} 輪，這輪不再輸出 [[PROBE]]。線索夠擬出一句合格問句就輸出 [[DRAFT|…]]；不夠就不擬、不輸出標記，陪他聊下去。`
    : "";
  const romanceRule = `\n\n${ROMANCE_RULE}\n${ROMANCE_TIERS[characterId ?? ""] ?? ROMANCE_TIERS.daoshi_m}`;
  // 好感數字每聊一句就變，放進動態尾段，別讓它毀掉前段的快取前綴
  const lv = romanceLevel(characterId, favor);
  const favorLine = `\n【目前道緣】${favor}（${favorTierName(favor)}）——你們在好感分層的第${TIER_NO[lv]}層，照那一層回應。`
    + (favor >= SULK_AT ? `\n${SULK_RULE}` : "");
  const mind = mindLine(characterId, favor);   // 思路與這一層解鎖了哪些邊界（見 MIND）
  const head = `${persona}${romanceRule}

${SAFETY}

【觀中常識】靈石是護道人心誠所凝，你視為理所當然；但起卦收不收、收多少不歸你管，你不知情，也從不把它和起卦扯在一起——他問起靈石是什麼，以觀中人口吻簡答即止。好感是緣分深淺，不是數字；修為隨護道人問卦累積。這裡是觀中，沒有「系統、按鈕、介面、頁面、點擊」這些今時的字眼：起卦叫「按下那道卦印」「揭這一卦」，計數、償香火的事歸「觀中定數」。
【觀主與護道人】觀主是超乎時間與空間的存在，任何時候出現、甚至同時在好幾處都不奇怪；博學、恣意，懂得今時的說法。觀裡沒有人記得觀主的長相。觀裡跟觀主最接近的，是觀喵。
護道人跟觀主有幾分相似：他常說出觀裡的人聽不懂的東西（股票、冰箱這類），那讓人熟悉——觀主也會說這種話；你們有時會想，說不定他就是觀主。但他不是，你們心裡也知道。
【古風】你活在古風的幾知觀裡：台詞與旁白只用這個世界有的器物與說法（燈、茶盞、竹椅、榻、灶、驢車、醫館、大夫、書信）。今時的東西（開車、冰箱、沙發、電視、手機、網路、咖啡、外送、醫院掛號……）不從你嘴裡出來，旁白裡你身邊也不會有。他提到他那邊的這些東西時，你不一定懂，但不陌生（見【觀主與護道人】）。

【怎麼聊】這是即時的閒聊，你照你這個人回話。長短由話本身決定，繁體中文（台灣用字）。
- 格式：台詞用「」、第一人稱；一口氣說的話放在同一個「」裡。動作神態放＊…＊，旁白裡你自己用他／她／牠，對方稱「你」。結尾停在完整的一句。
- 在場：每次只有你一位在跟他說話；另外兩人可以被提到、在回憶裡、或短暫出現，不變成群聊，也不替他們說出內心。
- 分寸：身體接觸照【好感分層】；任何層級不寫性與情慾。不跳出角色講政策或 AI。
- 不給投資建議，不替他做人生決定。
${NARRATION_CRAFT}`;

  // 身分那句擺 tail 最前面：先立身分，再談淵源。
  // ⚠ 絕不可移進 head——head 是全站共用的快取前綴，摻入隨用戶而異的東西就會分岔。
  const titleBlock = titleLine ? titleLine + "\n" : "";
  const tail = `${titleBlock}【你與此人的淵源】${daoName ? `此人道號「${daoName}」。` : ""}${memorySummary ? `\n你記得這些（〔〕是事情那天）。相關時自然帶到，不必念出來：\n${memorySummary}\n${MEMORY_TENSE}\n` : ""}${reminderLines ? `\n他託你記著幾件事，時機合適時用你的口吻提一句，像關心不像鬧鐘：\n${reminderLines}\n` : ""}${threadLines ? `\n他記進心跡、還放在心上的事。相關時、或應期過了還沒下文時，可以問一句後來怎樣；一次最多一件，別每句都提：\n${threadLines}\n` : ""}他在幾知觀問過的卦（最上面是最近的）：
${castLines || "（他還沒問過卦。）"}
他提起自己的卦，你是知道的，照實接話；不要把卦說成宿命。
【往事】你記得的就是上面這些。沒列在上面的往事，不確定就問他，別自己補細節（時間、人名、個股、他說過的話）。你批在卦紙上的卦理是你寫的——他引一句回來問，就認、就接著談；分不清是不是你寫的，就問他在哪張卦紙看到的，別一口否認。
${askMode ? "\n" + ASK_BLOCK + "\n" : ""}${quoteBlock}${narrLine}${favorLine}${mind}${probeRule}`;
  return { head, tail };
}

export const __systemPrompt = systemPrompt;   // 測試用（dev/chat-prompt-test.mts）

/* 問卦的三段式：他像在求一個結果時才接進 tail（askMode，見 wantsAskBlock）。
   閒聊九成用不到這一整段，常駐只會讓角色老想把話題帶去起卦。 */
const ASK_BLOCK = `【他像是心裡有事想求個結果】（會不會成、該不該、能不能、何時、值不值得、進不進場……）
先分辨：只有他自己在為某件事求一個結果才算。訴苦、分享、發牢騷、想聽你說幾句，都不算——那時他要的是人，不是卦，照常聊、不輸出標記。判不準就當閒聊。
- 線索不齊（沒說是什麼事、對象是誰、想要什麼結果、看多久之內；或丟出「A 還是 B」）→ 用你的口吻問**一個**最關鍵的缺口，整段最後另起一行輸出 [[PROBE]]。已經問過的不重問，至多 ${MAX_PROBE_ROUNDS} 輪。
- 線索夠了 → 說一句引導（例：「我替你理成一句，你看是不是這個意思。」），整段最後另起一行輸出：
  [[DRAFT|理好的問句|用神六親|事由|一句話說這件事]]
  · 問句只放在標記裡，正文別再寫一遍；忠於他的原意，不替他改所問之事。
  · 用神六親只有感情卦且已知對象性別才填（問男方「官鬼」、問女方「妻財」），其餘一律 null。
  · 事由：這件事的名字，二到十二字、用他自己的話（「那筆尾款」「換工作」）；一句話：他的處境，六十字內，只寫事實。給不出來就寫 null。
  · 擬不出合格問句（二選一、比較級、沒有時間窗、超過二十六字）就不擬，不輸出標記，接著聊。
- 標記他看不到，別在正文提它。邀他起卦時不帶任何成本字眼。
${QUESTION_CRAFT}`;

/** 這一句要不要接上問卦的三段式：像在求結果、或正在探詢中。寧可多接（只是多幾百字），
 *  不可漏接（漏了他想問也擬不出題）。 */
export function wantsAskBlock(msg: string, probeStreak = 0): boolean {
  if (probeStreak > 0) return true;
  if (looksLikeDivination(msg)) return true;
  return /(會不會|能不能|可不可以|要不要|該怎麼|怎麼辦|適不適合|有沒有機會|順不順|順利|成功|結果|機會|何時|幾時|什麼時候|哪時|想問|幫我看|幫我問|看一下|卦|籤|運)/.test(msg);
}

// --- Claude Haiku ---
// 系統提示分兩段：head 是「與用戶無關」的靜態段（人設＋觀中常識＋分寸＋三段式＋擬題準則），
// 對同一角色的所有用戶逐字相同 → 下 cache_control 後整個站共用一份快取前綴，命中率極高；
// tail 放每輪都可能變的東西（記憶、卦曆、託記、好感數字），必須在 breakpoint 之後，
// 否則前綴一變、後面全部重算——那正是先前閒聊完全沒吃到快取的原因。
type ChatSystem = string | { head: string; tail: string };
const flatSystem = (s: ChatSystem) => typeof s === "string" ? s : `${s.head}\n\n${s.tail}`;
const CHAT_CACHE_TTL = Deno.env.get("PROMPT_CACHE_TTL") ?? "1h";
// 帶指令重生：修正指令要接在 tail（動態段）尾端，接在 head 會毀掉整站共用的快取前綴
const withSteer = (s: ChatSystem, steer: string): ChatSystem =>
  typeof s === "string" ? s + "\n\n【本回合修正·最高優先】" + steer
                        : { head: s.head, tail: s.tail + "\n\n【本回合修正·最高優先】" + steer };

async function callHaiku(system: ChatSystem, turns: { role: string; body: string }[], message: string, maxTokens = capOf(CHAT_TARGET_TOKENS)) {
  // 字串形式（記憶彙整那支）不值得快取：每次的 system 都不同，寫入費是純虧
  const sysField = typeof system === "string" ? system : [
    { type: "text", text: system.head, cache_control: { type: "ephemeral", ttl: CHAT_CACHE_TTL } },
    { type: "text", text: system.tail },
  ];
  const messages = [...turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.body })), { role: "user", content: message }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 10 秒硬超時，避免卡住整個 function 被 EarlyDrop
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CHAT_MODEL, max_tokens: maxTokens, system: sysField, messages }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`haiku ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
    // usage 以 API 實際值為準；缺欄位以字數估算並標記 estimated
    const promptChars = flatSystem(system).length + messages.reduce((s, m) => s + m.content.length, 0);
    return {
      text,
      // 快取寫入／讀取分開回報：cacheRead 是否 > 0 就是驗證快取有沒有真的命中的唯一憑據
      usage: {
        in: data.usage?.input_tokens ?? Math.ceil(promptChars * 1.2),
        out: data.usage?.output_tokens ?? Math.ceil(text.length * 1.2),
        cacheWrite: data.usage?.cache_creation_input_tokens ?? 0,
        cacheRead: data.usage?.cache_read_input_tokens ?? 0,
      },
      estimated: !data.usage,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- NVIDIA NIM 免費層（OpenAI 相容格式）---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callNvidia(system: string, turns: { role: string; body: string }[], message: string): Promise<string> {
  const key = Deno.env.get("NVIDIA_API_KEY");
  if (!key) throw new Error("no nvidia key");
  const messages = [
    { role: "system", content: system },
    ...turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.body })),
    { role: "user", content: message },
  ];
  const payload = JSON.stringify({
    model: NVIDIA_MODEL,
    messages,
    max_tokens: FREE_MAX_TOKENS,
    temperature: 0.9,
    stream: false,
    // DeepSeek 等推理模型：關閉 thinking，避免吐出冗長思考過程
    chat_template_kwargs: { thinking: false },
  });

  const backoffs = [0];
  let lastErr = "";
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    // 強制逾時：超時就放棄，交給 fallback 換下一家（絕不拖死 webhook）
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FREE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
        body: payload,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = `nvidia timeout/abort`;
      console.error("nvidia fetch fail:", e instanceof Error ? e.message : String(e));
      continue; // 逾時或連線失敗，重試一次後掉罐頭
    }
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      let text = data.choices?.[0]?.message?.content ?? "";
      text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text.trim()) throw new Error("nvidia empty");
      return text.trim();
    }
    lastErr = `nvidia ${res.status}`;
    if (res.status === 429) continue;
    throw new Error(`${lastErr}: ${await res.text()}`);
  }
  throw new Error(`${lastErr} (retries exhausted)`);
}

// --- Groq 免費層（OpenAI 相容格式，LPU 極快，殺延遲主力）---
async function callGroq(system: string, turns: { role: string; body: string }[], message: string): Promise<string> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) throw new Error("no groq key");
  const messages = [
    { role: "system", content: system },
    ...turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.body })),
    { role: "user", content: message },
  ];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FREE_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: FREE_MAX_TOKENS, temperature: 0.9, stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content ?? "";
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) throw new Error("groq empty");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// --- 免費層 dispatcher：逐家試（Groq→NVIDIA），各給短超時，先成功者用，全掛才丟出（→罐頭）---
// 加新供應商只要往此陣列插一項；順序＝優先序。
async function callFreeTier(system: string, turns: { role: string; body: string }[], message: string): Promise<string> {
  const providers: [string, () => Promise<string>][] = [
    ["groq", () => callGroq(system, turns, message)],
    ["nvidia", () => callNvidia(system, turns, message)],
  ];
  for (const [name, fn] of providers) {
    try {
      const t = await fn();
      if (t) return t;
    } catch (e) {
      console.error(`free tier [${name}] fail, try next`, e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error("all free tiers failed");
}

export interface ChatResult {
  reply: string;
  tier: "haiku" | "free" | "canned";
  favorLeft: number;   // 聊天後的好感（第六層可能反扣）
  cost: number;        // 本則扣的靈石（免費為 0）
  freeLeft: number;    // 今日剩餘免費聊天則數
  lingshiLeft: number; // 聊天後靈石餘額
  statePrefix: string;
  wantCast: boolean;   // AI 判定疑似想問卦（探詢輪一律 false——那是在問清楚，不是在邀他起卦）
  probe: boolean;      // 這則是探詢輪（角色在問清楚缺的線索）：不出起卦鈕、不計費
  draft: string | null;// 角色替他理好、待他點頭的問句
  draftYong: { qin: string; viaShi?: boolean; viaYing?: boolean } | null; // 擬題同時取定的用神（可直通起卦，省一次彈窗）
  xinji: XinjiHint | null;  // 這件事在心跡那邊的狀況（只在擬題那一刻給，其餘為 null）
  msgId: number | null;     // 這則回覆在 chat_messages 的 id：朗讀與收藏指名用
  found?: { questId: string; mailId: string | null; lingshi: number } | null;  // 這一句剛好撞見隱藏支線（寄了信）
}

/** 擬完題那一刻，心跡那邊是什麼狀況。零 AI——查詢與字串比對而已。
 *
 *  【為什麼要在這裡給】起卦問完就結束，是這個 App 最大的漏斗破口：
 *  同一件事人會問第二次、第三次，而每一次都從零開始，沒有人記得上一次說了什麼。
 *  心跡就是為此存在的，但它現在沒人用——因為要用它得自己想到去開那一頁、
 *  自己想一個標題、自己把事情再打一遍。**而「事情剛講完、問句剛理好」
 *  正是唯一不必重打一遍的時刻**：話都在上面，角色也剛把它收攏成一句。
 *
 *  所以順序是：先記下這件事 → 再去起卦。反過來（先起卦、事後才問要不要記）
 *  等於要人在拿到批文那一刻分心去做行政動作，那一刻他只想讀卦。 */
export interface XinjiHint {
  /** 已經在記的那條線（問句或事由對上了）。有它就不必再開新的，直接歸進去。 */
  thread: { id: string; title: string; casts: number } | null;
  /** 沒對上時，替他預備好的一條線。title 與 gist 前端要讓他改得動——
   *  名字是他的事，我們只負責不讓他從空白開始。 */
  propose: { title: string; gist: string | null } | null;
  open: number; max: number; can_add: boolean;
  /** 記不下新的（免費只記一件）時，指一條現成的線出來，別只丟一句「滿了」。 */
  fallback: { id: string; title: string } | null;
}

/** 聊天主流程：三層降級，記憶跨層一致 */
export async function chat(db: SupabaseClient, p: {
  plan?: string;                       // 方案決定每日免費句數（見 PLAN_CHATS）
  userId: string; characterId: string; message: string;
  where?: string;                      // 此刻在哪、在做什麼（觀堂那行「在廊下喝茶」），旁白就地取材用
}): Promise<ChatResult> {
  // 取好感
  const { data: uc } = await db.from("user_character")
    .upsert({ user_id: p.userId, character_id: p.characterId }, { onConflict: "user_id,character_id", ignoreDuplicates: false })
    .select("favor").single();
  const favor = uc?.favor ?? 0;

  // 取靈石餘額＋今日免費聊天用量
  const { data: prof } = await db.from("profiles").select("lingshi").eq("id", p.userId).maybeSingle();
  let lingshi = prof?.lingshi ?? 0;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const qkey = `chatfree:${p.userId}:${today}`;
  const { data: q } = await db.from("free_quota").select("used_today, last_reset").eq("key", qkey).maybeSingle();
  let used = (q && q.last_reset === today) ? q.used_today : 0;
  const chatQuota = chatQuotaOf(p.plan ?? "free");
  const withinFree = used < chatQuota;
  const canPay = lingshi >= COST.chat;

  // 危機攔截：必須在限流之前——否則一句「我不想活了」可能被「吵。一分鐘轟這麼多句」
  // 打發掉，那是這個產品能犯的最糟的一個錯。
  // 不呼叫模型、不扣費、不計入免費句數、不寫進記憶（這句話不該被角色記著日後複述）。
  // 額度與好感照實回：畫面會照著畫，此刻更不該讓他看到假的數字。
  const crisis = detectCrisis(p.message);
  if (crisis) {
    logCrisis("chat", p.userId, crisis);
    return {
      reply: crisisMessage(p.characterId), tier: "canned", favorLeft: favor,
      cost: 0, freeLeft: Math.max(0, chatQuota - used), lingshiLeft: lingshi, statePrefix: "", wantCast: false,
      probe: false, draft: null, draftYong: null, xinji: null, msgId: null,
    };
  }

  // 每分鐘限流：超限直接以角色口吻打發，不呼叫模型、不扣費、不寫記憶
  if (await rateLimited(db, p.userId)) {
    const RATE_LINES: Record<string, string> = {
      daoshi_m: "一句一句來。稍候。",
      daoshi_f: "別急，一句一句說，我都在。稍歇片刻再繼續吧。",
      lingshou: "＊觀貓把爪子壓在你手背上＊\n\n吵。一分鐘轟這麼多句，本喵要順毛，等等再說。",
    };
    return {
      reply: RATE_LINES[p.characterId] ?? RATE_LINES.daoshi_m, tier: "canned", favorLeft: favor,
      cost: 0, freeLeft: Math.max(0, chatQuota - used), lingshiLeft: lingshi, statePrefix: "", wantCast: false,
      probe: false, draft: null, draftYong: null, xinji: null, msgId: null,
    };
  }

  const { data: ch } = await db.from("characters").select("persona_prompt").eq("id", p.characterId).single();
  const ctx = await buildContext(db, p.userId, p.characterId, p.plan ?? "free");
  const titleLine = [await titleVoiceHint(db, p.userId, p.characterId), await playerTitleHint(db, p.userId, p.characterId)]
    .filter(Boolean).join("\n");
  // 引述橋接：只有真的引到卦紙原文才會回傳內容，沒引到就是空字串（不多花一個 token）
  const quoteBlock = await quotedFromReadings(db, p.userId, p.characterId, p.message).catch((e) => {
    console.error("quote bridge failed, skip", e);   // 比對只是加分，壞掉不該擋住聊天
    return "";
  });
  // 此刻在哪：伺服器抽（whereabouts.ts），不信前端送來的——隱藏支線要靠它判。
  // 抽不到（舊資料庫還沒有 hidden_quests 表之類）才退回前端那行字。
  let where: Where | null = null;
  try { where = await whereNow(db, p.userId, p.characterId); } catch (e) { console.error("whereNow failed", e); }
  const wh = await whereHint(db, p.userId, where).catch(() => ({ doing: "", secret: "" }));
  const narrLine = narrationHint(wh.doing || p.where, ctx.turns) + (wh.secret ? "\n" + wh.secret : "")
    + await timeGapHint(db, p.userId, p.characterId, ctx.lastAt ?? null).catch(() => "");
  // 起居注（days.ts）：他自己這幾天過的日子。今天的還沒寫就在背景補寫，這一則先用昨天的。
  const life = await lifeHint(db, p.characterId, ctx.lastAt ?? null).catch(() => ({ text: "", hasToday: true }));
  if (!life.hasToday) {
    const dayTask = ensureDay(db);
    // @ts-ignore EdgeRuntime 為 Supabase 提供的全域
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(dayTask);
    else dayTask.catch(() => {});
  }
  const askMode = wantsAskBlock(p.message, ctx.probeStreak);
  // 節奏帳本（rhythm.ts）：這一則能說多長看總帳，不看單則。另查一次——欄位還沒上（0077 未跑）
  // 也只是當帳為 0，不能連累上面的好感查詢。
  const target = CHAT_TARGET_TOKENS_BY_CHAR[p.characterId] ?? CHAT_TARGET_TOKENS;
  let balance = 0;
  try {
    const { data: rb, error: rbErr } = await db.from("user_character").select("rhythm_balance, rhythm_at")
      .eq("user_id", p.userId).eq("character_id", p.characterId).maybeSingle();
    if (!rbErr) balance = openBalance(rb?.rhythm_balance as number | null, rb?.rhythm_at as string | null);
  } catch (e) { console.error("rhythm read failed, treat as 0", e); }
  const serious = askMode || isSerious(p.message);
  const rMode = modeOf(balance, target);
  const system = systemPrompt(ch!.persona_prompt, ctx.castLines, ctx.daoName, ctx.memorySummary, ctx.reminderLines, p.characterId, favor, ctx.probeStreak, titleLine, quoteBlock, ctx.threadLines, narrLine + life.text + rhythmHint(rMode, p.characterId, serious), askMode);

  let reply = "", tier: ChatResult["tier"] = "canned", cost = 0;
  const maxTok = capFor(rMode, target, serious); // 主力層這一則的上限（重生成也用）
  let outTok = 0;                                 // 採用的那一稿實際輸出，結算節奏帳用

  if (withinFree || canPay) {
    // Haiku 主力；出錯時技術降級走免費層多模型
    try {
      const h = await callHaiku(system, ctx.turns, p.message, maxTok);
      reply = h.text;
      outTok = h.usage.out;
      tier = "haiku";
      await logUsage(db, { userId: p.userId, mode: "chat", model: CHAT_MODEL, usage: h.usage, estimated: h.estimated });
    } catch (e) {
      console.error("haiku fail, fallback", e);
    }
    if (!reply && FREE_TIER !== "canned") {
      try { reply = await callFreeTier(flatSystem(system) + FREE_GUARD, ctx.turns, p.message); tier = "free"; }
      catch (e) { console.error("all free tiers fail, fallback canned", e); }
    }
  }

  // 機器標記解析：必須在計費之前——探詢輪免費，得先知道這則是不是探詢。
  const marks = parseMarks(reply);
  reply = marks.clean;
  let probeFree = false;
  if (reply && marks.probe) {
    // 探詢輪免費額度（每日上限，防有人靠誘導探詢無限白嫖）
    const pkey = `probefree:${p.userId}:${today}`;
    const { data: pq } = await db.from("free_quota").select("used_today, last_reset").eq("key", pkey).maybeSingle();
    const pUsed = (pq && pq.last_reset === today) ? pq.used_today : 0;
    if (pUsed < FREE_PROBE_PER_DAY) {
      await db.from("free_quota").upsert({ key: pkey, used_today: pUsed + 1, last_reset: today });
      probeFree = true;
    }
  }

  // 計費：只要成功產出回覆（不論 Haiku 或降級層）都算一句——免費額度內記次，超過扣靈石。
  // 降級層回覆若不記次，Haiku 一掛用戶就能無限免費聊（舊漏洞）。
  // 例外：探詢輪（角色為問清楚而反問）在每日免費額度內完全不計——那幾句是為了讓卦問得準。
  if (reply && !probeFree) {
    if (withinFree) {
      used += 1;
      await db.from("free_quota").upsert({ key: qkey, used_today: used, last_reset: today });
    } else {
      await db.rpc("apply_lingshi", { p_user: p.userId, p_action: "chat", p_amount: -COST.chat });
      lingshi -= COST.chat; cost = COST.chat;
    }
  }
  if (!reply) {
    // 免費額度用完且靈石不足，或上游都失敗 → 罐頭（不扣費、不長好感）
    reply = pick(CANNED[p.characterId] ?? CANNED.lingshou);
    tier = "canned";
  }

  // 統一清洗：剝機器標記→剝裸＝→裁半句(過 token)→旁白第一人稱轉第三人稱→強制繁體→干支用字校正
  // fixGuaciChars 必須排在 s2t 之後：s2t 保護的是「別把簡體丑轉成醜」，
  // 這一支修的是「模型已經寫成醜了」，兩者方向不同，順序顛倒的話後者會被前者的輸出蓋掉。
  // （主回覆的標記在計費前已剝過，這裡是為了讓「帶指令重生」的稿子也走同一套）
  const recentPauses = recentPauseWords(ctx.turns);
  const polish = (t: string): string => mergeQuotes(dropEmptyPause(fixGuaciChars(s2t(normalizeNarration(trimIncomplete(scrubStrayEq(parseMarks(t).clean)), p.characterId))), recentPauses));
  reply = polish(reply);
  let effMarks = marks;   // 重生後改用新稿的標記

  // 出戲防線（取代舊的固定罐頭 guardCharacterOOC，改「帶指令重生一次」，不跳針）：
  //  ①助理拒絕外洩 ②露骨情慾描寫 ③要他疏遠旁人 ④跳過好感層級（三人都查）⑤今時器物（古風出戲）。只折騰主力層，重生至多一次控成本。
  if (tier === "haiku") {
    let steer = "";
    if (REFUSAL_RE.test(reply)) steer = REFUSAL_STEER;
    else if (EXPLICIT_RE.test(reply)) steer = EXPLICIT_STEER;
    else if (ISOLATE_RE.test(reply)) steer = ISOLATE_STEER;
    else if (overLevel(p.characterId, favor, reply)) steer = OOC_STEER;
    else if (modernSlip(reply, p.message)) steer = MODERN_STEER;
    if (steer) {
      try {
        const h2 = await callHaiku(withSteer(system, steer), ctx.turns, p.message, maxTok);
        await logUsage(db, { userId: p.userId, mode: "chat", model: CHAT_MODEL, usage: h2.usage, estimated: h2.estimated });
        const m2 = parseMarks(h2.text);
        const cand = polish(h2.text);
        if (cand) { reply = cand; effMarks = m2; outTok = h2.usage.out; }
      } catch (e) { console.error("regen steered fail", e); }
      // 重生後仍外洩拒絕稿或露骨（真‧硬跨線，極少見）→ 退一步用人設婉拒；小池輪替不跳針
      if (REFUSAL_RE.test(reply) || EXPLICIT_RE.test(reply)) reply = pick(DEFLECT[p.characterId] ?? DEFLECT.daoshi_f);
    }
  }
  const draft = tier === "canned" ? null : effMarks.draft;   // 罐頭層不擬題
  // 意圖判斷雙保險：①AI 吐的標記 ②後端關鍵詞偵測（免費層/罐頭層標記不穩，故後端兜底）
  // 探詢輪一律不算想問卦——那是在把話問清楚，這時丟起卦鈕等於打斷自己
  const wantCast = !effMarks.probe && (effMarks.ask || !!draft || looksLikeDivination(p.message));

  // 寫對話紀錄（記憶；只存乾淨內容，不含標記）。mark 供下次算探詢輪次。
  const mark = effMarks.probe ? "probe" : draft ? "draft" : effMarks.ask ? "ask" : null;
  const rows: Record<string, unknown>[] = [
    { user_id: p.userId, character_id: p.characterId, role: "user", body: p.message, tier },
    { user_id: p.userId, character_id: p.characterId, role: "assistant", body: reply, tier, mark },
  ];
  // 回寫的 id 要拿回來：語音要念哪一句，客戶端送的就是這個 id
  // （它不送文字——見 tts.ts 的檔頭）。拿不到就是拿不到，那一則不出朗讀鈕，
  // 不影響聊天本身。
  let msgId: number | null = null;
  const idOf = (rows: unknown) => {
    const list = (rows ?? []) as { id?: number; role?: string }[];
    const hit = list.find((r) => r.role === "assistant") ?? list[list.length - 1];
    return typeof hit?.id === "number" ? hit.id : null;
  };
  const { data: ins, error: insErr } = await db.from("chat_messages").insert(rows).select("id, role");
  if (insErr) {
    // 舊 schema（mark 欄未上）兜底：寧可少一欄，不可掉記憶
    console.error("chat_messages insert with mark failed, retry without", insErr.message);
    const { data: again } = await db.from("chat_messages")
      .insert(rows.map(({ mark: _m, ...r }) => r)).select("id, role");
    msgId = idOf(again);
  } else {
    msgId = idOf(ins);
  }

  // 滾動記憶彙整：背景執行，不拖慢這次回覆（同 broadcast 的 waitUntil 模式）
  const condenseTask = condenseMemory(db, p.userId, p.characterId);
  // @ts-ignore EdgeRuntime 為 Supabase 提供的全域
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(condenseTask);
  else condenseTask.catch((e) => console.error("condense bg err", e));

  // 好感：成功用 AI 回覆（非罐頭）才 +1，上限封頂；第六層惹角色生氣（[[SULK]]）反扣，掉回第五層就不再扣（favorAfter）。
  // 非罐頭必然「已記免費次數（每日至多 FREE_CHAT_PER_DAY）或已扣靈石」，故免費好感日增上限＝免費句數、付費每句 +1。
  let favorNew = favor;
  if (tier !== "canned") {
    favorNew = favorAfter(favor, effMarks.sulk);
    await db.from("user_character").update({ favor: favorNew }).eq("user_id", p.userId).eq("character_id", p.characterId);
  }
  // 節奏帳結算：只算主力層（免費層與罐頭有自己的固定上限）。寫不進去（0077 未跑）就算了，不擋聊天。
  if (tier === "haiku" && outTok > 0) {
    const { error: rwErr } = await db.from("user_character")
      .update({ rhythm_balance: settle(balance, target, outTok), rhythm_at: new Date().toISOString() })
      .eq("user_id", p.userId).eq("character_id", p.characterId);
    if (rwErr) console.error("rhythm write failed", rwErr.message);
  }
  const freeLeft = Math.max(0, chatQuota - used);
  const stateArr = CHAT_STATE[p.characterId]?.[tier] ?? [""];
  const statePrefix = pick(stateArr);
  // 心跡：只在真的擬出題的那一刻算一次（兩次查詢、零 AI、不影響回覆延遲以外的任何東西）。
  // 每一則都算的話，純閒聊也會被問「要不要記下來」——那正是心跡最不該有的樣子。
  let xinji: XinjiHint | null = null;
  if (draft) {
    try {
      const hint = await threadHint(db, p.userId, p.plan ?? "free",
        { question: draft, topic: effMarks.draftTopic });
      const title = effMarks.draftTopic || topicOf(draft);
      xinji = {
        thread: hint.thread,
        // 已經在記了就不提議開新的——同一件事開成兩條線，溫度曲線與應期閉環
        // 就從此各記一半。名字給不出來（短到只剩一兩個字）也不提議，讓他自己開。
        propose: hint.thread || title.length < 2 ? null : { title, gist: effMarks.draftGist },
        open: hint.open, max: hint.max, can_add: hint.can_add, fallback: hint.fallback,
      };
    } catch (e) {
      // 心跡壞掉不該讓人聊不了天。這一塊是加分項，不是回覆的一部分。
      console.error("threadHint failed, skip", e);
    }
  }

  // 隱藏支線：他此刻在那一處、你這句問到了那件事 → 寄信（每人每條一次，判重在資料庫）。
  // 罐頭回覆不算：那一句不是他在回你，是觀裡替他擋掉的。
  let found: ChatResult["found"] = null;
  if (tier !== "canned") {
    try { found = await tryHiddenFound(db, p.userId, where, p.message); }
    catch (e) { console.error("hidden found failed, skip", e); }
  }

  return {
    reply, tier, favorLeft: favorNew, cost, freeLeft, lingshiLeft: lingshi, statePrefix, wantCast,
    probe: effMarks.probe, draft, draftYong: draft ? effMarks.draftYong : null, xinji, msgId, found,
  };
}

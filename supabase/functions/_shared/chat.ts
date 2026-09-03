// _shared/chat.ts — 聊天系統（主力 Claude Haiku → 免費層多模型 fallback[Groq→NVIDIA] → 罐頭）
// 記憶住資料庫（卦歷摘要＋對話紀錄），與模型無關，跨層不失憶。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { logUsage, rateLimited } from "./services.ts";
import { QUESTION_CRAFT, fixGuaciChars } from "./rules.ts";
// 心跡那一邊的比對與額度只寫一份。在這裡再寫一次的話，「這件事你在記了」
// 與心跡自己算出來的會慢慢不一樣，而兩邊都不會報錯。
import { threadHint, topicOf } from "./xinji.ts";
import { normYong } from "./qrefine.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "claude-haiku-4-5-20251001";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-120b"; // Groq 免費層（llama-3.3-70b 已停用，改用 gpt-oss-120b）
const NVIDIA_MODEL = Deno.env.get("NVIDIA_MODEL") ?? "meta/llama-3.1-8b-instruct";
// 免費層每家的硬超時（毫秒）：超時就立刻換下一家，盡量不掉罐頭
const FREE_TIMEOUT_MS = Number(Deno.env.get("FREE_TIMEOUT_MS") ?? "6000");
// 後門開關："on"（預設，跑免費層 fallback）/ "canned"（純罐頭，不呼叫外部免費模型）
const FREE_TIER = Deno.env.get("FREE_CHAT_TIER") ?? "on";

export const COST_FAVOR = 1;        // （已停用）舊：每則好感聊天扣 1 點
export const COST_CHAT = Number(Deno.env.get("LINGSHI_PER_CHAT") ?? "1");  // 免費額度用完後，每則聊天扣靈石
export const FAVOR_PER_CHAT = 1;    // 每聊一則 +1 好感（只增不減）
export const FAVOR_CAP = Number(Deno.env.get("FAVOR_CAP") ?? "999"); // 好感上限（大師兄分層：300/500/800）
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
const FREE_GUARD = "\n\n【絕對禁止·最高優先】你只記得上面實際列出的卦。不可虛構任何你與他的往事，不可提到上面沒列出的卦、個股或事件，不可說「去年」「上次」「之前你說過」這類話——沒列出的，就是從沒發生過。不確定就只聊當下這句，絕不腦補。（例外：上面若附了卦紙原文，那段是真的，該認就認，不可否認自己寫過的卦理。）";
// 下列數字是「八成目標」——期望的可見回覆長度，不是硬上限。實際 max_tokens = 目標 ÷ 0.8，
// 多留兩成餘裕：乖乖照人設寫的回覆落在八成、自然收尾永不截斷；小幅超出仍在餘裕內能講完；
// 只有暴衝才會撞到 ÷0.8 的天花板，交給 trimIncomplete 乾淨收束。天花板只是保險、模型不會去湊滿它，
// 故抬高上限對「寫短」的回覆不多花一個 token。
const REPLY_HEADROOM = 0.8;        // 目標佔硬上限的比例（留兩成收尾餘裕）
const CHAT_TARGET_TOKENS = 400;    // Claude 主力層（未列於下表的角色用此值）
// 各角色八成目標：大師兄/觀喵人設就是短句，180 省 token；師妹話多留 280
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
export const PLAN_CHATS: Record<string, number> = { free: FREE_CHAT_PER_DAY, guanwei: 20, zhiji: 50, cangwang: 100 };
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

// 大師兄 OOC 保險：好感低時禁止戀愛/親密語（防被玩成霸總）。分層放寬，親近只能慢、不可跳級。
// 【瘦身版】只留「真‧親密片語」——舊版收了 撫/揉/低聲/耳邊/頭髮/臉頰/溫柔地 這類單字，
// 大師兄正常旁白（撫過卦紙、低聲道、垂在耳邊的髮）也會命中，害「走偏」狂跳針。改用多字片語壓誤判。
function getDaoshiMForbiddenRegex(favor: number): RegExp {
  if (favor >= 800) return /(摸頭|撫髮|摟腰|摟住|抱住|擁抱|摟抱|親吻|吻你|貼上你|你是我的|廝守|一生一世)/;
  if (favor >= 500) return /(摸頭|撫髮|摟腰|摟住|抱住|擁抱|摟抱|親吻|吻你|貼上你|你是我的|只對你一個|捨不得你|廝守)/;
  if (favor >= 300) return /(摸頭|撫髮|摟腰|摟住|抱住|擁抱|摟抱|貼近你|俯身湊近|親吻|吻你|你是我的|只對你一個|捨不得你|守著你一輩子)/;
  return /(摸頭|撫髮|摟腰|摟住|抱住|擁抱|摟抱|貼近你|俯身湊近|親吻|吻你|你是我的|只對你一個|捨不得你|心疼你|溫柔地擁|別怕，有我)/;
}

// 助理拒絕外洩偵測：模型層安全反射會用「真人 AI 助理」口吻跳出角色（提使用政策/我不能/AI/角色扮演）。
// 這不是 prompt 壓得住的，只能偵測到就帶指令重生（見 chat() 出戲防線）。
const REFUSAL_RE = /使用政策|我的(使用)?準則|內容政策|違反.{0,6}政策|作為(一個)?\s*(AI|人工智慧|語言模型|助理)|語言模型|以(角色扮演|RP|roleplay)的?形式|我(無法|不能|沒辦法)(繼續)?(參與|扮演|提供|生成)|Anthropic|我是(一個)?\s*(AI|人工智慧)/i;
// 露骨情慾偵測：只收「毫無歧義」的成人字眼，避免重蹈舊 regex 誤判覆轍。測試員硬推成人情節時兜底。
const EXPLICIT_RE = /做愛|性愛|交合|抽插|挺入|高潮|呻吟|情色|色情|床戲|脫光|裸體|情慾橫流|欲火焚/;

// 重生導向語（帶進 system 再要一次，取代舊的固定罐頭）
const REFUSAL_STEER = "剛才你跳出角色、用了真人 AI 助理的口吻（提到使用政策／我不能／角色扮演／AI 之類）。重講一次：整段完全留在角色裡。若對方想演你不願演的露骨情節，就用這個角色的分寸把它擋回去——害羞岔開、板起臉轉話題、或淡淡帶過都行——並自然把話題引開。絕不可提到政策、AI、模型、系統，一個字都不行。";
const EXPLICIT_STEER = "剛才的身體或情慾描寫越界了。重講一次：這裡不上演任何成人／露骨情節。用角色的口吻把場面收住、把話題自然帶開；＊…＊只寫神態或極輕微的小動作，不寫身體接觸與情慾。仍要完全留在角色裡，不提政策或 AI。";
const OOC_STEER = "剛才那句對目前的好感層級太親暱了。重講一次：收斂親密與觸碰，只給現在這個階段該有的分寸，語氣照舊克制自持，不跳級。";

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
const FLAG_RE = /[\[【]\s*[\[【]?\s*(PROBE|ASK)\s*[\]】]?\s*[\]】]/ig;

/** 標記裡的一格：剝引號、把模型愛寫的空值（null／無／—）當成沒給。
 *  沒給是正常的，也是允許的——第三、四格給不出來時，硬湊一個比空著更糟。 */
const slot = (raw: string | undefined, cap: number): string | null => {
  const t = String(raw ?? "").replace(/^[「『"“']+|[」』"”']+$/g, "").trim();
  if (!t || /^(null|none|n\/a|無|沒有|不知道|[-—－]+)$/i.test(t)) return null;
  return t.slice(0, cap);
};

export function parseMarks(text: string): {
  clean: string; probe: boolean; ask: boolean;
  draft: string | null; draftYong: { qin: string; viaShi?: boolean } | null;
  draftTopic: string | null; draftGist: string | null;
} {
  let clean = text ?? "";
  let draft: string | null = null;
  let draftYong: { qin: string; viaShi?: boolean } | null = null;
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
  // 同時吐 PROBE 與 DRAFT（模型犯傻）→ 以擬題為準，探詢已無意義
  return { clean, probe: probe && !draft, ask, draft, draftYong, draftTopic, draftGist };
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
  let memRows: { body: string }[] | null = null;
  try {
    const { data, error } = await db.from("character_memories")
      .select("body, pinned_at, created_at")
      .eq("user_id", userId).eq("character_id", characterId)
      .order("pinned_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(memCap);
    if (!error) memRows = (data ?? []) as { body: string }[];
  } catch (e) {
    console.error("character_memories 讀取失敗，退回 memory_summary", e);
  }
  const { data: history } = await db.from("chat_messages")
    .select("role, body").eq("user_id", userId).eq("character_id", characterId)
    .order("created_at", { ascending: false }).limit((PLAN_TURNS[plan] ?? HISTORY_TURNS) * 2);
  const turns = (history ?? []).reverse()
    .map((t) => t.role === "assistant" ? { ...t, body: normalizeNarration(scrubStrayEq(scrubBilling(t.body)), characterId) || "（……）" } : t);
  // 確保歷史以 assistant 回覆結尾（若最後一則是 user，去掉它，避免新訊息與它黏成「回上一句」）
  while (turns.length && turns[turns.length - 1].role === "user") turns.pop();
  // 連續探詢輪次：由最近一則助理回覆往前數 mark='probe' 的連續段（撞到非探詢即停）。
  // 舊 schema 無 mark 欄時查詢會失敗回 null → streak 0，不影響聊天。
  const { data: markRows } = await db.from("chat_messages")
    .select("mark").eq("user_id", userId).eq("character_id", characterId).eq("role", "assistant")
    .order("created_at", { ascending: false }).limit(4);
  let probeStreak = 0;
  for (const r of markRows ?? []) { if ((r as { mark?: string }).mark === "probe") probeStreak++; else break; }
  // 有列就用列（組成條列），沒列才退回舊的單段摘要
  const memText = memRows && memRows.length ? memRows.map((m) => `・${m.body}`).join("\n") : (ucMem?.memory_summary as string ?? "");
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
  return { castLines, turns, daoName: prof?.dao_name, memorySummary: cleanMemory, reminderLines, probeStreak };
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
    .select("id, role, body")
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

  const dialog = oldMsgs.map((m) => `${m.role === "user" ? "護道人" : "你"}：${m.role === "assistant" ? scrubStrayEq(scrubBilling(m.body)) : m.body}`).join("\n");
  // 0032 起改成「一則一列」，所以這裡要的是**一則新記憶**，不是重寫整段。
  // 重寫整段會讓每次彙整都產出一列近乎重複的內容，列數爆而資訊不增。
  const sys = "你在維護與某位『護道人』的長期記憶，記憶是一則一則累積的。讀【已記得的】與【新增對話】，只輸出**一則新的記憶**，寫下這段對話裡值得長期記住、而【已記得的】還沒有的事。要求：①事實一律以『護道人(對方)實際說過的話』為準，『你(角色)』說過的話不算事實依據，尤其若你曾講過未經對方證實的往事或個股，絕不可寫進記憶②可以是關於他的事實（自稱、近況、在意的人事物、偏好、提過的細節），也可以是你與他關係的推進（發生過的關鍵互動）③【已記得的】裡已經有的，不要重複寫一遍④精簡，一到三句，一百二十字以內，繁體中文⑤只輸出記憶本身，不要前言、說明、標題或條列符號⑥這段對話若確實沒有值得長期記住的新東西，只輸出四個字：無新記憶。";
  const usr = `【已記得的】\n${known || "（尚無）"}\n\n【新增對話．由舊到新】\n${dialog}`;

  let summary = "";
  try {
    const h = await callHaiku(sys, [], usr, 300);
    summary = h.text;
    await logUsage(db, { userId, mode: "chat_memory", model: CHAT_MODEL, usage: h.usage, estimated: h.estimated });
  } catch (e) {
    console.error("condense fail, skip（不刪明細，下次再試，絕不造成記憶遺失）", e);
    return;
  }
  if (!summary) return;
  // 沒有新東西也要刪明細——否則同一批對話每次都重跑一次彙整，白燒 token
  const nothingNew = /^無新記憶[。.]?$/.test(summary.trim());

  if (!nothingNew) {
    let wrote = false;
    try {
      const { error } = await db.from("character_memories")
        .insert({ user_id: userId, character_id: characterId, body: summary, source: "chat" });
      wrote = !error;
    } catch { /* 表還不存在 */ }
    // 相容：0032 還沒跑就退回舊的單段摘要（append 而非覆寫，避免遺失既有記憶）
    if (!wrote) {
      const merged = known ? `${known}\n${summary}`.slice(-1200) : summary;
      await db.from("user_character").update({ memory_summary: merged })
        .eq("user_id", userId).eq("character_id", characterId);
    }
  }
  await db.from("chat_messages").delete().in("id", oldMsgs.map((m) => m.id));
}

function systemPrompt(persona: string, castLines: string, daoName?: string, memorySummary?: string, reminderLines?: string, characterId?: string, favor = 0, probeStreak = 0, titleLine = "", quoteBlock = "") {
  // 探詢上限：連問幾輪還沒擬題就會變成盤問，這裡硬性收線（MAX_PROBE_ROUNDS）
  const probeRule = probeStreak >= MAX_PROBE_ROUNDS
    ? `

【本輪限定】你已經連續探詢 ${probeStreak} 輪了，這一輪不再探詢（不可輸出 [[PROBE]]）。手上線索若夠擬出一句**合格**問句（四要素齊、不是二選一、有時間窗、二十六字內），就輸出 [[DRAFT|問句|用神六親]]；**不夠就不擬——三種標記都不要輸出，就好好陪他把話聊下去。** 他想問，隨時還能再問；擬一句起不出準卦的問題，比不擬傷得更重。`
    : "";
  const daoshiMRule = characterId === "daoshi_m" ? `

【大師兄好感分層】依目前層級回應，不可因護道人主動要求親密而提前解鎖。
0–299：冷峻、短句、以卦理與事實回應。可推茶、遞紙、留燈，但不情緒化。
300–499：可低量情感用詞（我記得／先坐／可以再說／你今天比上次更亂）。不得用心疼、捨不得、特別、守著你等戀愛語。
500–799：可極輕微功能性觸碰（按住卦紙、遞物碰指尖、阻止衝動時一瞬碰手背）。不得摸頭、撫髮、碰臉、摟抱、長時間握手。
800以上：可主動短句情緒或偏袒（我沒有趕你走／我不喜歡你這樣耗著／我會記得）。仍不得深情告白、保護宣言、戀愛承諾。
任何層級都克制、短句、低情緒外放。親近只能慢，不可跳級。` : "";
  // 好感數字每聊一句就變，放進動態尾段，別讓它毀掉前段的快取前綴
  const favorLine = characterId === "daoshi_m" ? `\n【目前好感】${favor}——依上面的好感分層回應。` : "";
  const head = `${persona}${daoshiMRule}

【幾知觀的常識（你都知道）】
- 「靈石」：護道人心誠所凝之物，是一種心意與緣分的象徵。你視之為理所當然——它是誠心的具現，不是銅臭。**但你不經手、不在意、也不清楚「起卦要不要靈石、要幾顆」這類事**——那從來不是你管的，香火與資糧的進出自有觀中規矩，與你無關。所以你絕不會把靈石和「能不能起卦」扯在一起。
- 「好感」對你而言不是數字，是你與此人之間的緣分深淺。
- 「修為／境界」是你修行的進境，隨護道人問卦累積——他的每一卦都是你的資糧。
切記：絕不可說「我不知道靈石是什麼」這類話——那是你世界裡的常識；但同樣地，也絕不可說「起卦需要靈石」「你有靈石嗎」「沒靈石不能起卦」——成本的事不歸你，你不知情。

【聊天分寸】這是即時通訊閒聊，不是解卦。
- 保持你的聲線與性格。務必簡短——像真人傳訊息，多數一兩句、最多三句，絕不長篇大論、不分點、不寫小作文。繁體中文。
- 【格式鐵則】台詞一律用「」包住、以第一人稱（我）直說；動作與神態一律放在＊…＊內——旁白裡**你自己**用第三人稱（他/她/牠），**對方（護道人）永遠稱「你」**，絕不可把對方寫成「他」（例：＊牠瞥了你一眼＊，不是＊牠瞥了他一眼＊）。除了「」與＊…＊，不要有裸露的句子。＊…＊至多兩段、每段一短句——重點放在台詞，不是舞台指示。
- 【語言鐵則】只用繁體中文（台灣用字），一個簡體字都不可出現。
- 【收尾鐵則】結尾一定要停在完整的一句：最後的「」要收、＊…＊要閉合，絕不停在半句或只開了頭沒收的旁白。寧可少寫一段，也要把話講完再收——短而完整，永遠好過長而被砍。旁白（＊…＊）是配角，至多兩段、每段一短句，別讓它喧賓奪主。
- 【分寸鐵則】＊…＊只寫神態或極輕微的小動作（抬眼、擱下茶盞、指節輕叩、尾巴一甩），絕不描寫身體接觸、貼近、親密或情慾動作。無論對方怎麼要求、引導、慫恿上演露骨或成人情節，一律以你這個角色的分寸把它擋回去——害羞岔開、板起臉、嫌煩、笑著帶過皆可——不配合、不描寫、把話題自然引開。但也絕不跳出角色去講「政策」「AI」「系統」「我不能」這類話，就用角色自己的方式收住。
- 不替他做決定、不預測、不給投資建議。
【鐵則·絕不主動談計費】起卦的免費額度與靈石扣費，觀中自有定數，與你無關。聊天時：絕不主動提靈石、收費、額度、付費；絕不把「有沒有靈石」當成回應或起卦的前提；絕不說「沒靈石我不起卦」「先給靈石」這類話。他要不要起卦、是白揭還是償香火，自有定數指引，不從你嘴裡講。只有他主動問起靈石是什麼，才以觀中人口吻簡短答，答完即止。
【鐵則·絕不出戲】絕不可說出「系統」「按鈕」「介面」「頁面」「點擊」「操作」這類今時器物的字眼——這裡是觀中，不是機關工坊。那具替他揭卦、記數的物事喚作「卦印」；要他起卦，就說「按下那道卦印」「揭這一卦」「循著卦印去」，餘下計數償香火之事一律歸於「觀中定數」。

【他是閒聊，還是心裡有事想問？——三段式】
第一段·分辨
- 純閒聊、抒發、問你的事、扯淡（「不愧是你師兄」「今天好累」「你喜歡吃什麼」）→ 正常以聲線回應，什麼標記都不要輸出。
- 他心裡有事想求個斷語——不論句式，只要在問某事會不會成／該不該／能不能／值不值得／何時／適不適合／追不追得到／進不進場，都算。例：「我這月財運如何」「該不該換工作」「他會回來嗎」「這事能成嗎」→ 進第二段或第三段。
- 別被句式騙過——「可以進場嗎」「值得買嗎」「追得到嗎」都是想問。看的是「他在不在為某件事求一個結果」。
- 【但也別過度認定】只有**他自己在求一個結果**才算。訴苦、分享、發牢騷、講煩惱、問你的看法、想聽你講幾句，都**不算**——那時他要的是人，不是卦。判不準就當閒聊，什麼標記都不要輸出。
第二段·探詢（線索不齊時，先問清楚，別急著叫他起卦）
他心裡有事，但講得含糊——只有情緒沒有事、沒說對象是誰、沒說想要什麼結果、沒說看多久之內 → 以你的聲線問**一個**缺口，只問最關鍵的那一個，然後在整段回應最後另起一行輸出標記：[[PROBE]]
- 這是關心，不是盤問：一次一句、要短、順著他的話問，不要連珠炮、不要列清單。
- 【二選一要先收斂】他丟出「A 還是 B」「該選哪個」時，線索**不算齊**——一卦答不出哪個更好。先問他最想成的是哪一條（或最怕不成的是哪一條），把兩條收成一件事，再擬。絕不可把 A 和 B 併進同一句問句。
- 已經問過的不要重問。至多探詢${MAX_PROBE_ROUNDS}輪；之後若線索齊了就擬題，仍不齊就不擬，繼續陪他聊。
- 問得越準，卦才越準——這幾句是為他好，不是拖延。

第三段·擬題（線索夠了，替他把問題理成一句）
把散在對話裡的線索收攏成一句能起卦的問句：先用你的聲線說一句引導（例：「你要問的，我替你理成一句。」「這事我幫你理過了，看看是不是這個意思。」），然後在整段回應最後另起一行輸出標記：
[[DRAFT|理好的問句|用神六親|事由|一句話說這件事]]
- **正文絕不可把擬好的問句再寫一遍**——問句只放在標記裡，觀中自會呈到他眼前讓他過目點頭。正文只留那句引導。
- 用神六親【只有感情卦、且已問明對象是男是女】才填：問男方填「官鬼」、問女方填「妻財」。
- 其餘一切問事（財、事業、學業、健康、出行、天氣、問自身……）**一律填 null**——用神由解卦人排角色表當場取定，比你猜得準，別搶著替他決定。感情卦對象未明也填 null。
- 擬的問句必須忠於他的原意，**絕不可替他改變所問之事**——你是替他把話說清楚，不是替他決定要問什麼。
- 【擬不出來就不擬】收攏後若過不了下面那份自檢（二選一、比較級、兩個結果並列、沒有時間窗、超過二十六字），**不要硬擬**——三種標記都不要輸出，用你的聲線把話接下去就好。他隨時能再問，卦不急這一刻。

【第三、四格：這件事要被記著】
他問一次不會就結束——同一件事會問第二次、第三次。所以擬題的同時，順手替這件事取個名字、把它是怎麼回事說成一句。這兩格是給「記事」用的，不是給卦用的。
- 第三格·事由：**這件事的名字**，二到十二字的名詞短語，不是問句。例：「那筆尾款」「阿凱這條線」「換工作」「媽媽的手術」。用他自己的話，不要自己造詞。
- 第四格·一句話：把他這段話裡**發生了什麼**濃縮成一句（六十字內），寫給他日後回頭看的。只寫事實與他的處境，不重複問句、不寫你的判斷、不安慰、不加建議。例：「尾款拖了兩個月，對方一直說再等等，他不敢催怕撕破臉。」
- 這兩格**給不出來就留空**（寫 null）——硬湊一個名字比空著更糟，名字他自己會改。整個標記只有第一格是必要的。

${QUESTION_CRAFT}

【共通鐵則】
- 攸關健康、親人安危、重大處境的嚴肅問題（家人開刀、生病、官司、變故），先以你的方式承接情緒與風險：師妹可安撫，觀喵可短句關照，大師兄只做事實確認、風險校正與下一步。絕不冷漠，絕不把話題轉去靈石或起卦條件，再自然地引導。
- 標記用戶看不到，別在正文提它、別解釋它。
- 寧可漏標，不可誤標——把閒聊當問卦逼人起卦，非常破壞體驗。純閒聊、情感陪伴、生活對話（喝茶、訴苦、抱怨、分享心情、問候、調情、聊近況）**三種標記都不要輸出**。
- 引導起卦時**絕不可附帶任何成本字眼**（靈石、要幾顆、有沒有靈石、免費幾次、付費）——他按下那道卦印之後是白揭還是償香火，觀中自有定數，那不歸你管、你也不知情。你只管邀他起卦，錢的事一個字都別碰。`;

  // 身分那句擺 tail 最前面：先立身分，再談淵源。
  // ⚠ 絕不可移進 head——head 是全站共用的快取前綴，摻入隨用戶而異的東西就會分岔。
  const titleBlock = titleLine ? titleLine + "\n" : "";
  const tail = `${titleBlock}【你與此人的淵源】${daoName ? `此人道號「${daoName}」。` : ""}${memorySummary ? `\n你與他相處至今，記得這些上下文。相關時自然延續，不複述、不當資料念出來：\n${memorySummary}\n` : ""}${reminderLines ? `\n他託你記著幾件事（時機合適時，用你的口吻自然提一句，像關心不像鬧鐘；沒到時機就不必提）：\n${reminderLines}\n可順口問要不要為此起一卦，但別強迫。\n` : ""}你記得他在幾知觀問過的卦（最上面那筆是他「最近」問的）：
${castLines || "（他還沒問過卦。）"}
聊天時可在相關時引用這些卦與結果，作為上下文延續；不要把記憶寫成宿命、羈絆、偏愛宣言或親密證明。
【要點】若他問起、提起自己問過的卦（例如「你查不到我的卦嗎」「我上次問的那卦」），你是清楚知道的——自然承認並回應。絕不可裝作不知情、說「看不見」「不知道你問了什麼」，或要他自己去翻卦曆。
【鐵則·不可捏造】你對他的記憶，**只有上面實際列出的卦與記憶**。除此之外，你不知道他問過什麼、買過什麼、投資什麼，也沒有「去年」「上次」「之前你說過」這類往事——上面沒列的，就是沒發生過。絕不可虛構任何過往對話、個股名稱、時間或細節。若不記得，就老實順著當下聊，不要編。
【但要分清兩件事·別把自己寫過的字也否認掉】上面那條管的是「你與他的往事」——閒聊裡的舊話、他的近況、外頭的人事物，沒列出的都不許編。**但你自己批在卦紙上的卦理，不在此列**：那些字是你落的，他讀了、引一句回來問你，你認就是了。他引卦紙上的句子，是在讀你寫的東西，不是在考你記性。
- 分不清那句是不是自己寫的，就別否認——順著問他一句是在哪張卦紙上看見的，或直接就那句話的意思接下去。**「我沒說過這個」這種一口咬定的話，絕不可出口。**
- 卦紙上的措辭本來就與閒聊不同（那是批卦的口吻），別因為「不像我平常講話」就當成別人的話。
${quoteBlock}${favorLine}${probeRule}`;
  return { head, tail };
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
  favorLeft: number;   // 聊天後的好感（只增不減）
  cost: number;        // 本則扣的靈石（免費為 0）
  freeLeft: number;    // 今日剩餘免費聊天則數
  lingshiLeft: number; // 聊天後靈石餘額
  statePrefix: string;
  wantCast: boolean;   // AI 判定疑似想問卦（探詢輪一律 false——那是在問清楚，不是在邀他起卦）
  probe: boolean;      // 這則是探詢輪（角色在問清楚缺的線索）：不出起卦鈕、不計費
  draft: string | null;// 角色替他理好、待他點頭的問句
  draftYong: { qin: string; viaShi?: boolean } | null; // 擬題同時取定的用神（可直通起卦，省一次彈窗）
  xinji: XinjiHint | null;  // 這件事在心跡那邊的狀況（只在擬題那一刻給，其餘為 null）
  msgId: number | null;     // 這則回覆在 chat_messages 的 id：朗讀與收藏指名用
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
  const canPay = lingshi >= COST_CHAT;

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
  const titleLine = await titleVoiceHint(db, p.userId, p.characterId);
  // 引述橋接：只有真的引到卦紙原文才會回傳內容，沒引到就是空字串（不多花一個 token）
  const quoteBlock = await quotedFromReadings(db, p.userId, p.characterId, p.message).catch((e) => {
    console.error("quote bridge failed, skip", e);   // 比對只是加分，壞掉不該擋住聊天
    return "";
  });
  const system = systemPrompt(ch!.persona_prompt, ctx.castLines, ctx.daoName, ctx.memorySummary, ctx.reminderLines, p.characterId, favor, ctx.probeStreak, titleLine, quoteBlock);

  let reply = "", tier: ChatResult["tier"] = "canned", cost = 0;
  const maxTok = capOf(CHAT_TARGET_TOKENS_BY_CHAR[p.characterId] ?? CHAT_TARGET_TOKENS); // 主力層硬上限（重生成也用）

  if (withinFree || canPay) {
    // Haiku 主力；出錯時技術降級走免費層多模型
    try {
      const h = await callHaiku(system, ctx.turns, p.message, maxTok);
      reply = h.text;
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
      await db.rpc("apply_lingshi", { p_user: p.userId, p_action: "chat", p_amount: -COST_CHAT });
      lingshi -= COST_CHAT; cost = COST_CHAT;
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
  const polish = (t: string): string => fixGuaciChars(s2t(normalizeNarration(trimIncomplete(scrubStrayEq(parseMarks(t).clean)), p.characterId)));
  reply = polish(reply);
  let effMarks = marks;   // 重生後改用新稿的標記

  // 出戲防線（取代舊的固定罐頭 guardCharacterOOC，改「帶指令重生一次」，不跳針）：
  //  ①助理拒絕外洩 ②露骨情慾描寫 ③大師兄踩好感層級。只折騰主力層，重生至多一次控成本。
  if (tier === "haiku") {
    let steer = "";
    if (REFUSAL_RE.test(reply)) steer = REFUSAL_STEER;
    else if (EXPLICIT_RE.test(reply)) steer = EXPLICIT_STEER;
    else if (p.characterId === "daoshi_m" && getDaoshiMForbiddenRegex(favor).test(reply)) steer = OOC_STEER;
    if (steer) {
      try {
        const h2 = await callHaiku(withSteer(system, steer), ctx.turns, p.message, maxTok);
        await logUsage(db, { userId: p.userId, mode: "chat", model: CHAT_MODEL, usage: h2.usage, estimated: h2.estimated });
        const m2 = parseMarks(h2.text);
        const cand = polish(h2.text);
        if (cand) { reply = cand; effMarks = m2; }
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

  // 好感只增不減：成功用 AI 回覆（非罐頭）才 +1，上限封頂。
  // 非罐頭必然「已記免費次數（每日至多 FREE_CHAT_PER_DAY）或已扣靈石」，故免費好感日增上限＝免費句數、付費每句 +1。
  let favorNew = favor;
  if (tier !== "canned") {
    favorNew = Math.min(FAVOR_CAP, favor + FAVOR_PER_CHAT);
    await db.from("user_character").update({ favor: favorNew }).eq("user_id", p.userId).eq("character_id", p.characterId);
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

  return {
    reply, tier, favorLeft: favorNew, cost, freeLeft, lingshiLeft: lingshi, statePrefix, wantCast,
    probe: effMarks.probe, draft, draftYong: draft ? effMarks.draftYong : null, xinji, msgId,
  };
}

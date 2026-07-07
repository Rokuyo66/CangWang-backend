// _shared/chat.ts — 聊天系統（主力 Claude Haiku → 免費層多模型 fallback[Groq→NVIDIA] → 罐頭）
// 記憶住資料庫（卦歷摘要＋對話紀錄），與模型無關，跨層不失憶。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

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
export const FAVOR_CAP = 999;       // 好感上限
const HISTORY_TURNS = 6;            // 注入最近幾輪對話
const MEMORY_CONDENSE_AT = 40;      // chat_messages 累積超過此數 → 觸發滾動彙整

// 引號感知第一人稱正規化：「」外（動作/旁白/敘事）的「我」一律轉第三人稱，「」內台詞保留。
// 治「模型把動作寫成第一人稱」＋「舊污染回灌當 few-shot」。deterministic、零 token、零延遲。
const THIRD_PERSON: Record<string, string> = { daoshi_m: "他", daoshi_f: "她", lingshou: "牠" };
function normalizeNarration(text: string, characterId: string): string {
  if (!text) return text;
  const pron = THIRD_PERSON[characterId] ?? "他";
  // 以「」為界切段：捕獲組使 split 保留分隔符；奇數段＝引號內台詞（不動），偶數段＝引號外敘事（正規化）
  return text.split(/(「[^」]*」)/).map((seg, i) => {
    if (i % 2 === 1) return seg;               // 台詞：保留「我」
    return seg.replace(/我/g, pron);           // 敘事：我→他/她/牠（我的→X的、我們→X們自動涵蓋）
  }).join("");
}
const MEMORY_KEEP_RECENT = 20;      // 彙整後保留最近幾則明細（>HISTORY_TURNS*2=12，留緩衝避免斷層）
// 免費層（小模型 llama）易編造往事，額外加一道硬性防捏造，只塞免費層、不影響 Haiku（省 token）
const FREE_GUARD = "\n\n【絕對禁止·最高優先】你只記得上面實際列出的卦。不可虛構任何你與他的往事，不可提到上面沒列出的卦、個股或事件，不可說「去年」「上次」「之前你說過」這類話——沒列出的，就是從沒發生過。不確定就只聊當下這句，絕不腦補。";
const CHAT_MAX_TOKENS = 400;       // Claude 主力層
const FREE_MAX_TOKENS = 220;       // 免費層（DeepSeek 等易長篇，壓更短）
export const FREE_CHAT_PER_DAY = Number(Deno.env.get("FREE_CHAT_PER_DAY") ?? "15"); // 每人每日免費聊天上限（額度內不扣、超過每則扣靈石）

// 繁體強制（日後多語言從此開關擴充）。"0"=關閉
export const FORCE_TRAD = (Deno.env.get("FORCE_TRAD") ?? "1") !== "0";
// 簡→繁「安全子集」：只收高頻、無歧義字。歧義字（干/后/里/面/沖/复/发/台/系/历/钟…）一律不收，
// 由 S2T_PROTECT 於載入時強制刪除，確保干支等卦理用字絕不被誤轉。全量正確待日後接 OpenCC 片語級。
const S2T: Record<string, string> = { "这":"這","时":"時","会":"會","应":"應","关":"關","门":"門","问":"問","术":"術","灵":"靈","与":"與","请":"請","让":"讓","学":"學","实":"實","点":"點","边":"邊","过":"過","还":"還","现":"現","众":"眾","义":"義","乐":"樂","买":"買","卖":"賣","贵":"貴","钱":"錢","银":"銀","财":"財","运":"運","势":"勢","战":"戰","处":"處","断":"斷","继":"繼","观":"觀","归":"歸","岁":"歲","万":"萬","双":"雙","变":"變","达":"達","龙":"龍","凤":"鳳","缘":"緣","惊":"驚","怀":"懷","忆":"憶","恋":"戀","爱":"愛","亲":"親","见":"見","讲":"講","谈":"談","语":"語","谁":"誰","难":"難","顺":"順","顾":"顧","题":"題","页":"頁","预":"預","领":"領","风":"風","飞":"飛","马":"馬","鱼":"魚","鸟":"鳥","认":"認","识":"識","记":"記","讨":"討","设":"設","访":"訪","词":"詞","试":"試","诚":"誠","话":"話","该":"該","误":"誤","读":"讀","谢":"謝","贴":"貼","购":"購","费":"費","资":"資","赢":"贏","输":"輸","转":"轉","软":"軟","连":"連","进":"進","远":"遠","违":"違","迟":"遲","选":"選","递":"遞","无":"無","书":"書","车":"車","东":"東","来":"來","个":"個","们":"們","为":"為","儿":"兒","写":"寫","军":"軍","农":"農","医":"醫","华":"華","单":"單","卫":"衛","县":"縣","参":"參","号":"號","吗":"嗎","听":"聽","员":"員","团":"團","图":"圖","国":"國","场":"場","坏":"壞","块":"塊","坚":"堅","执":"執","扩":"擴","扫":"掃","护":"護","报":"報","担":"擔","挂":"掛","换":"換","据":"據","掷":"擲","携":"攜","摄":"攝","敌":"敵","旧":"舊","显":"顯","权":"權","条":"條","极":"極","检":"檢","楼":"樓","样":"樣","树":"樹","标":"標","气":"氣","汉":"漢","汤":"湯","没":"沒","沟":"溝","泪":"淚","洁":"潔","济":"濟","润":"潤","涨":"漲","渐":"漸","温":"溫","湾":"灣","满":"滿","滚":"滾","灭":"滅","灯":"燈","炉":"爐","热":"熱","烦":"煩","烧":"燒","状":"狀","独":"獨","环":"環","码":"碼","礼":"禮","离":"離","种":"種","积":"積","称":"稱","稳":"穩","穷":"窮","笔":"筆","篮":"籃","类":"類","红":"紅","约":"約","级":"級","纪":"紀","纯":"純","纳":"納","纵":"縱","纸":"紙","线":"線","练":"練","组":"組","细":"細","织":"織","终":"終","经":"經","结":"結","绕":"繞","绘":"繪","给":"給","络":"絡","绝":"絕","统":"統","绩":"績","续":"續","维":"維","综":"綜","绿":"綠","缓":"緩","编":"編","缩":"縮","网":"網","罚":"罰","联":"聯","聪":"聰","肠":"腸","肤":"膚","肿":"腫","脑":"腦","节":"節","药":"藥","蓝":"藍","补":"補","装":"裝","规":"規","视":"視","览":"覽","觉":"覺","订":"訂","计":"計","讯":"訊","许":"許","证":"證","评":"評","诉":"訴","译":"譯","诗":"詩","询":"詢","详":"詳","课":"課","调":"調","谋":"謀","谎":"謊","谐":"諧","谓":"謂","谦":"謙","谨":"謹","贝":"貝","负":"負","贡":"貢","责":"責","贤":"賢","败":"敗","货":"貨","质":"質","贫":"貧","贯":"貫","贱":"賤","贷":"貸","贺":"賀","贼":"賊","赏":"賞","赔":"賠","赖":"賴","赚":"賺","赛":"賽","赠":"贈","趋":"趨","跃":"躍","践":"踐","轨":"軌","轮":"輪","轰":"轟","轻":"輕","载":"載","较":"較","辆":"輛","辈":"輩","辉":"輝","辖":"轄","辞":"辭","遗":"遺","郑":"鄭","邮":"郵","钉":"釘","钓":"釣","钢":"鋼","钥":"鑰","钩":"鉤","钮":"鈕","铁":"鐵","铃":"鈴","铅":"鉛","铝":"鋁","铜":"銅","铭":"銘","铺":"鋪","链":"鏈","销":"銷","锁":"鎖","锅":"鍋","锋":"鋒","错":"錯","锦":"錦","键":"鍵","镜":"鏡","长":"長","闪":"閃","闭":"閉","间":"間","闷":"悶","阁":"閣","阅":"閱","队":"隊","阶":"階","际":"際","陆":"陸","陈":"陳","阴":"陰","阵":"陣","阳":"陽","隐":"隱","雾":"霧","静":"靜","韩":"韓","顶":"頂","顿":"頓","颁":"頒","频":"頻","颗":"顆","颜":"顏","额":"額","飘":"飄","饥":"飢","饭":"飯","饮":"飲","饰":"飾","饱":"飽","饲":"飼","饼":"餅","饿":"餓","馈":"饋","驱":"驅","驳":"駁","驶":"駛","驻":"駐","驾":"駕","验":"驗","骂":"罵","骄":"驕","骗":"騙","骤":"驟","鲁":"魯","鲜":"鮮","鸣":"鳴","鸭":"鴨","鸿":"鴻","鹅":"鵝","鹰":"鷹","麦":"麥","黄":"黃","齐":"齊","齿":"齒","龄":"齡" };
// 保護：這些簡體形在繁體另有別義（尤其干支/卦理），一律不轉
const S2T_PROTECT = ["干","后","里","面","系","松","谷","表","板","范","采","云","台","只","制","发","复","历","钟","获","余","冲","斗","借","咸","涂","尽","汇","团","姜","布","丑","沈"];
for (const k of S2T_PROTECT) delete S2T[k];
function s2t(text: string): string {
  if (!FORCE_TRAD || !text) return text;
  let out = "";
  for (const ch of text) out += S2T[ch] ?? ch;
  return out;
}

// 大師兄 OOC 保險：好感低時禁止戀愛/親密語（防被玩成霸總）。分層放寬，親近只能慢、不可跳級。
function getDaoshiMForbiddenRegex(favor: number): RegExp {
  if (favor >= 800) return /(摸頭|撫髮|髮絲|碰臉|臉頰|額頭|摟|抱|耳邊|我會一直陪你|我會守著你|你是我的|只對你|我不想失去你)/;
  if (favor >= 500) return /(摸頭|撫髮|髮絲|碰臉|臉頰|額頭|摟|抱|耳邊|心疼|捨不得|我會守著你|你很特別|只對你|你是我的)/;
  if (favor >= 300) return /(撫|揉|摟|抱|貼近|靠近你|俯身|耳邊|髮絲|頭髮|額頭|臉頰|胸口|心疼|捨不得|守著你|陪著你|你很特別|只對你|你是我的)/;
  return /(撫|揉|摟|抱|貼近|靠近你|俯身|低聲|耳邊|髮絲|頭髮|額頭|臉頰|掌心|胸口|心疼|溫柔地|守著你|陪著你|你很特別|只對你|你是我的|別怕，有我)/;
}
function guardCharacterOOC(text: string, characterId: string, favor = 0): string {
  if (characterId !== "daoshi_m" || !text) return text;
  if (!getDaoshiMForbiddenRegex(favor).test(text)) return text;
  return "＊大師兄指尖停在卦紙邊緣＊\n\n「這句走偏了。」\n\n「換一個說法。」";
}

// 角色狀態文案（依層級。66 文風：以動作承載狀態，不直述情緒，反差收束）
export const CHAT_STATE: Record<string, Record<string, string[]>> = {
  lingshou: {
    haiku: [""],
    free: [
      "（尾巴尖在地上敲了兩下，就沒再動。一隻眼睜著。）",
      "（趴在案角，下巴擱在前爪上，看都沒看你。）",
      "（耳朵動了動，懶得抬頭。）",
      "（打了個哈欠，舌尖捲了一下。）",
    ],
    canned: [
      "（蜷成一團，尾巴蓋住鼻子，睡熟了。）",
      "（牠把臉埋進前爪，呼吸勻長，睡沉了。）",
    ],
  },
  daoshi_m: {
    haiku: [""],
    free: [
      "（他闔著眼，指節在案上叩了一下，停了。）",
      "（目光仍落在卦書上，沒抬。）",
      "（沉默了一瞬才開口。）",
      "（眉峰微動，語氣淡得很。）",
    ],
    canned: [
      "（他盯著卦書，整個人沒在這兒。）",
      "（指尖懸在某一爻上，停住了，沒往下。）",
    ],
  },
  daoshi_f: {
    haiku: [""],
    free: [
      "（她替自己也斟了一杯，沒喝，握著。）",
      "（指尖在杯沿繞了一圈。）",
      "（她偏頭看了你一會兒。）",
      "（茶氣散了，她輕輕嗯了一聲。）",
    ],
    canned: [
      "（鄰桌的香客喚了她，她回頭比了個『稍等』。）",
      "（廊下有人喚她，她起身應了一聲。）",
    ],
  },
};

// 罐頭墊底台詞（兩層 AI 皆未接住時的暫代；多為暫時性，故給合理「暫時不在」之由並邀稍後再問。66 文風：留白、動作承載、不解釋）
const CANNED: Record<string, string[]> = {
  lingshou: [
    "……（沒醒，鬍鬚隨呼吸一動一動。）過會兒再來喚本喵一聲。",
    "本喵正打著盹……稍候片刻，再問一次。",
    "（一隻耳朵抖了下，又睡死了。）等牠醒，這話再說。",
  ],
  daoshi_m: [
    "……（他正鑽在一個卦裡，沒聽見。）稍待，再問他一次。",
    "他此刻心思全在盤上，分不出神。等等，再喚他一聲。",
    "（眉頭鎖著，盯著爻象，半晌沒回神。）過一會兒再說。",
  ],
  daoshi_f: [
    "方才有位香客急著問事，她先過去了——稍候片刻，再問她一次。",
    "她暫時走開了，說很快回來。等等再喚她。",
    "（那頭香客拉著她說話，她朝你歉意地笑了笑。）稍待，再問。",
  ],
};
const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

// 防污染回流：角色照規矩不該在聊天講計費，但舊歷史/記憶可能殘留「靈石/起卦需要」等污染句，
// 被當 context 餵回去會自我強化（模型沿自己舊話繼續講）。注入前濾掉這類句子（治本在 prompt，此為長期保險）。
const BILLING_RE = /靈石|起卦.{0,4}需要|付費|收費/;
const scrubBilling = (text: string): string => {
  if (!text || !BILLING_RE.test(text)) return text;
  return text.split(/(?<=[。！？\n])/).filter((s) => !BILLING_RE.test(s)).join("").trim();
};

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
async function buildContext(db: SupabaseClient, userId: string, characterId: string) {
  const { data: prof } = await db.from("profiles").select("cast_digest, dao_name").eq("id", userId).single();
  const { data: recentCasts } = await db.from("casts")
    .select("id, question, gua_ben, digest, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(3);
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
  // 長期記憶摘要（滾動彙整的產物）
  const { data: ucMem } = await db.from("user_character")
    .select("memory_summary").eq("user_id", userId).eq("character_id", characterId).maybeSingle();
  const { data: history } = await db.from("chat_messages")
    .select("role, body").eq("user_id", userId).eq("character_id", characterId)
    .order("created_at", { ascending: false }).limit(HISTORY_TURNS * 2);
  const turns = (history ?? []).reverse()
    .map((t) => t.role === "assistant" ? { ...t, body: normalizeNarration(scrubBilling(t.body), characterId) || "（……）" } : t);
  // 確保歷史以 assistant 回覆結尾（若最後一則是 user，去掉它，避免新訊息與它黏成「回上一句」）
  while (turns.length && turns[turns.length - 1].role === "user") turns.pop();
  const cleanMemory = scrubBilling(ucMem?.memory_summary as string ?? "") || undefined;
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
  return { castLines, turns, daoName: prof?.dao_name, memorySummary: cleanMemory, reminderLines };
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

  const { data: uc } = await db.from("user_character")
    .select("memory_summary").eq("user_id", userId).eq("character_id", characterId).maybeSingle();
  const prev = scrubBilling((uc?.memory_summary as string | undefined) ?? "");

  const dialog = oldMsgs.map((m) => `${m.role === "user" ? "護道人" : "你"}：${m.role === "assistant" ? scrubBilling(m.body) : m.body}`).join("\n");
  const sys = "你在維護與某位『護道人』的長期記憶。把【既有記憶】與【新增對話】合併成一份更新後的長期記憶，供你日後延續這段關係。要求：①保留關於護道人的事實（自稱、近況、在意的人事物、偏好、提過的細節）——事實一律以『護道人(對方)實際說過的話』為準，『你(角色)』說過的話不算事實依據，尤其若你曾講過未經對方證實的往事或個股，絕不可寫進記憶②保留你與他的關係與情感走向（從生疏到熟、發生過的關鍵互動）③精簡，短句或條列，繁體中文，全文不超過 300 字 ④只輸出記憶本身，不要任何前言、說明或標題。";
  const usr = `【既有記憶】\n${prev || "（尚無）"}\n\n【新增對話．由舊到新】\n${dialog}`;

  let summary = "";
  try {
    summary = await callHaiku(sys, [], usr, 600);
  } catch (e) {
    console.error("condense fail, skip（不刪明細，下次再試，絕不造成記憶遺失）", e);
    return;
  }
  if (!summary) return;

  await db.from("user_character").update({ memory_summary: summary })
    .eq("user_id", userId).eq("character_id", characterId);
  await db.from("chat_messages").delete().in("id", oldMsgs.map((m) => m.id));
}

function systemPrompt(persona: string, castLines: string, daoName?: string, memorySummary?: string, reminderLines?: string, characterId?: string, favor = 0) {
  const daoshiMRule = characterId === "daoshi_m" ? `

【大師兄好感分層】目前好感：${favor}。依目前層級回應，不可因護道人主動要求親密而提前解鎖。
0–299：冷峻、短句、以卦理與事實回應。可推茶、遞紙、留燈，但不情緒化。
300–499：可低量情感用詞（我記得／先坐／可以再說／你今天比上次更亂）。不得用心疼、捨不得、特別、守著你等戀愛語。
500–799：可極輕微功能性觸碰（按住卦紙、遞物碰指尖、阻止衝動時一瞬碰手背）。不得摸頭、撫髮、碰臉、摟抱、長時間握手。
800以上：可主動短句情緒或偏袒（我沒有趕你走／我不喜歡你這樣耗著／我會記得）。仍不得深情告白、保護宣言、戀愛承諾。
任何層級都克制、短句、低情緒外放。親近只能慢，不可跳級。` : "";
  return `${persona}${daoshiMRule}

【你與此人的淵源】${daoName ? `此人道號「${daoName}」。` : ""}${memorySummary ? `\n你與他相處至今，心裡記得這些（這是你們之間的事，自然延續，別複述、別當資料念出來）：\n${memorySummary}\n` : ""}${reminderLines ? `\n他託你記著幾件事（時機合適時，用你的口吻自然提一句，像關心不像鬧鐘；沒到時機就不必提）：\n${reminderLines}\n可順口問要不要為此起一卦，但別強迫。\n` : ""}你記得他在幾知觀問過的卦（最上面那筆是他「最近」問的）：
${castLines || "（他還沒問過卦。）"}
聊天時可自然引用這些卦與結果（這是只有你知道的事，是你與他的羈絆），但只在相關時提，不刻意賣弄。
【要點】若他問起、提起自己問過的卦（例如「你查不到我的卦嗎」「我上次問的那卦」），你是清楚知道的——自然承認並回應。絕不可裝作不知情、說「看不見」「不知道你問了什麼」，或要他自己去翻卦曆。
【鐵則·不可捏造】你對他的記憶，**只有上面實際列出的卦與記憶**。除此之外，你不知道他問過什麼、買過什麼、投資什麼，也沒有「去年」「上次」「之前你說過」這類往事——上面沒列的，就是沒發生過。絕不可虛構任何過往對話、個股名稱、時間或細節。若不記得，就老實順著當下聊，不要編。

【幾知觀的常識（你都知道）】
- 「靈石」：護道人心誠所凝之物，是一種心意與緣分的象徵。你視之為理所當然——它是誠心的具現，不是銅臭。**但你不經手、不在意、也不清楚「起卦要不要靈石、要幾顆」這類事**——那從來不是你管的，香火與資糧的進出自有觀中規矩，與你無關。所以你絕不會把靈石和「能不能起卦」扯在一起。
- 「好感」對你而言不是數字，是你與此人之間的緣分深淺。
- 「修為／境界」是你修行的進境，隨護道人問卦累積——他的每一卦都是你的資糧。
切記：絕不可說「我不知道靈石是什麼」這類話——那是你世界裡的常識；但同樣地，也絕不可說「起卦需要靈石」「你有靈石嗎」「沒靈石不能起卦」——成本的事不歸你，你不知情。

【聊天分寸】這是即時通訊閒聊，不是解卦。
- 保持你的聲線與性格。務必簡短——像真人傳訊息，多數一兩句、最多三句，絕不長篇大論、不分點、不寫小作文。繁體中文。
- 【語言鐵則】只用繁體中文（台灣用字），一個簡體字都不可出現。
- 不替他做決定、不預測、不給投資建議。
【鐵則·絕不主動談計費】起卦的免費額度與靈石扣費全由系統按鈕處理，與你無關。聊天時：絕不主動提靈石、收費、額度、付費；絕不把「有沒有靈石」當成回應或起卦的前提；絕不說「沒靈石我不起卦」「先給靈石」這類話。他要不要起卦、是免費還是付費，按鈕會告訴他，不從你嘴裡講。只有他主動問起靈石是什麼，才以觀中人口吻簡短答，答完即止。

【判斷他想閒聊還是想問卦】這很重要：
- 若他只是閒聊、抒發、問你的事、扯淡（如「不愧是你師兄」「今天好累」「你喜歡吃什麼」）→ 正常以角色聲線回應，不要叫他起卦。
- 若他像是想為某件具體的事求個吉凶斷語——不論句式，只要在問某事會不會成/該不該/能不能/可不可以/值不值得/何時/適不適合/進不進場/買不買，都算想問卦。例：「我這月財運如何」「該不該換工作」「他會回來嗎」「這支股票可以進場嗎」「這支要不要買」「我追得到她嗎」「這事能成嗎」→ 先以角色口吻簡短回應一句（可帶安慰或吐槽），然後反問要不要為此起一卦，並在整段回應最後另起一行輸出標記：[[ASK]]
- 尤其攸關健康、親人安危、重大處境的嚴肅問題（如家人開刀、生病、官司、變故），務必先以你的方式表達在意與安撫——哪怕你性格再冷，也是用你的方式關心，絕不可冷漠、絕不可把話題轉去靈石或起卦條件——再自然引導為此起一卦。
- 別被句式騙過——「可以進場嗎」「值得買嗎」「追得到嗎」都是問卦。看的是「他在不在問一件事的吉凶/結果/該不該」。
- 只有確實判斷想問卦時才輸出 [[ASK]]。純閒聊、情感陪伴、生活對話（喝茶、訴苦、抱怨、分享心情、問候、調情、聊近況）**絕不輸出**。判斷依據是「他是否想為某件具體的事求一個吉凶／成敗／時機的斷語」，而非只是提到生活或情緒。寧可漏標，不可誤標——把閒聊當問卦逼人起卦，非常破壞體驗。標記用戶看不到，別在正文提它。
- 引導起卦時，只溫和反問「要不要為此起一卦」即可，**絕不可附帶任何成本字眼**（靈石、要幾顆、有沒有靈石、免費幾次、付費）——他按下按鈕後，系統自會處理免費或扣費，那不歸你管、你也不知情。你只管邀他起卦，錢的事一個字都別碰。`;
}

// --- Claude Haiku ---
async function callHaiku(system: string, turns: { role: string; body: string }[], message: string, maxTokens = CHAT_MAX_TOKENS) {
  const messages = [...turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.body })), { role: "user", content: message }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 10 秒硬超時，避免卡住整個 function 被 EarlyDrop
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CHAT_MODEL, max_tokens: maxTokens, system, messages }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`haiku ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
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
  wantCast: boolean;   // AI 判定疑似想問卦
}

/** 聊天主流程：三層降級，記憶跨層一致 */
export async function chat(db: SupabaseClient, p: {
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
  const withinFree = used < FREE_CHAT_PER_DAY;
  const canPay = lingshi >= COST_CHAT;

  const { data: ch } = await db.from("characters").select("persona_prompt").eq("id", p.characterId).single();
  const ctx = await buildContext(db, p.userId, p.characterId);
  const system = systemPrompt(ch!.persona_prompt, ctx.castLines, ctx.daoName, ctx.memorySummary, ctx.reminderLines, p.characterId, favor);

  let reply = "", tier: ChatResult["tier"] = "canned", cost = 0;

  if (withinFree || canPay) {
    // Haiku 主力；出錯時技術降級走免費層多模型
    try {
      reply = await callHaiku(system, ctx.turns, p.message);
      tier = "haiku";
    } catch (e) {
      console.error("haiku fail, fallback", e);
    }
    if (!reply && FREE_TIER !== "canned") {
      try { reply = await callFreeTier(system + FREE_GUARD, ctx.turns, p.message); tier = "free"; }
      catch (e) { console.error("all free tiers fail, fallback canned", e); }
    }
    // 計費：只要成功產出回覆（不論 Haiku 或降級層）都算一句——免費額度內記次，超過扣靈石。
    // 降級層回覆若不記次，Haiku 一掛用戶就能無限免費聊（舊漏洞）。
    if (reply) {
      if (withinFree) {
        used += 1;
        await db.from("free_quota").upsert({ key: qkey, used_today: used, last_reset: today });
      } else {
        await db.rpc("apply_lingshi", { p_user: p.userId, p_action: "chat", p_amount: -COST_CHAT });
        lingshi -= COST_CHAT; cost = COST_CHAT;
      }
    }
  }
  if (!reply) {
    // 免費額度用完且靈石不足，或上游都失敗 → 罐頭（不扣費、不長好感）
    reply = pick(CANNED[p.characterId] ?? CANNED.lingshou);
    tier = "canned";
  }

  // 意圖判斷雙保險：①AI 吐的標記 ②後端關鍵詞偵測（免費層/罐頭層標記不穩，故後端兜底）
  // 容錯：小模型常把 [[ASK]] 寫成有空格的 [ [ASK ] ]、單括號 [ASK]、或全形 【ASK】，全部當標記處理並清除，避免裸奔給用戶
  const ASK_RE = /[\[【]\s*[\[【]?\s*ASK\s*[\]】]?\s*[\]】]/gi;
  const askMark = /[\[【]\s*[\[【]?\s*ASK\s*[\]】]?\s*[\]】]/i.test(reply);
  reply = reply.replace(ASK_RE, "").trim();
  reply = normalizeNarration(reply, p.characterId); // 引號外第一人稱敘事 → 第三人稱（存檔前先洗，歷史永遠乾淨）
  reply = s2t(reply);                                 // 強制繁體（安全子集，護干支等卦理字）
  reply = guardCharacterOOC(reply, p.characterId, favor); // 大師兄 OOC 防護（好感不足時擋戀愛/親密語）
  const wantCast = askMark || looksLikeDivination(p.message);

  // 寫對話紀錄（記憶；只存乾淨內容，不含標記）
  await db.from("chat_messages").insert([
    { user_id: p.userId, character_id: p.characterId, role: "user", body: p.message, tier },
    { user_id: p.userId, character_id: p.characterId, role: "assistant", body: reply, tier },
  ]);

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
  const freeLeft = Math.max(0, FREE_CHAT_PER_DAY - used);
  const stateArr = CHAT_STATE[p.characterId]?.[tier] ?? [""];
  const statePrefix = pick(stateArr);
  return { reply, tier, favorLeft: favorNew, cost, freeLeft, lingshiLeft: lingshi, statePrefix, wantCast };
}

// _shared/notify-admin.ts — 把需要觀主看一眼的事推到 Telegram
//
// 為什麼是 TG 而不是網頁後台或寄信：這個產品已經有一條管理者通道了
// （/stats、/broadcast 都走 ADMIN_TG_ID），接上去等於零新基礎設施。
// 網頁後台要多做一整頁 UI 與權限，而且他還得記得去看；寄信要接郵件服務商
// （新依賴、新費用、新 secret、投遞率問題），信到了也還是得點進來處理。
// 推播直接到手機，訊息底下兩顆鈕按完就結案，不必離開 Telegram。
//
// 【這一層絕不可以擋住主流程】
// 推播失敗（TG 掛了、token 過期、觀主封鎖了 bot）都只記一筆 log 就算了。
// 檢舉的本體是資料庫那一列，推播只是「讓他早點知道」——為了通知不成功而讓
// 使用者的檢舉整個失敗，是把附屬品看得比正事還重。漏推的那些，/reports
// 撈得回來。

const TG_BOT_TOKEN = Deno.env.get("TG_BOT_TOKEN") ?? "";
// 與 broadcast-command.ts、webhook-tg 同一個來源，三處必須一致
const ADMIN_TG_ID = Deno.env.get("ADMIN_TG_ID") ?? "8674594142";
// 推播是附屬品，不該讓它拖住正事（見下方 notifyAdmin 的逾時）
const NOTIFY_TIMEOUT_MS = Number(Deno.env.get("NOTIFY_TIMEOUT_MS") ?? "5000");

export type AdminButton = { text: string; data: string };

/** 推一則給觀主。失敗不拋、不回傳成敗——呼叫端不該因為它而改變行為。 */
export async function notifyAdmin(html: string, buttons: AdminButton[] = []): Promise<void> {
  if (!TG_BOT_TOKEN || !ADMIN_TG_ID) {
    console.warn("notifyAdmin skipped: TG_BOT_TOKEN 或 ADMIN_TG_ID 未設定");
    return;
  }
  // 硬逾時：這支是在使用者送出檢舉的請求裡同步跑的。Telegram 偶爾會掛住，
  // 沒有上限的話，他按下「檢舉」之後會一直轉，而檢舉其實早就寫進資料庫了。
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_TG_ID,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(buttons.length
          // 一排兩顆：下架／駁回並排，拇指一下就到，不必在清單裡找
          ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } }
          : {}),
      }),
    });
    if (!res.ok) console.error("notifyAdmin failed", res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    console.error("notifyAdmin threw", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** TG HTML 轉義。推播裡帶的是使用者寫的字，不轉義會被一個 < 弄壞整則訊息。 */
export const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 檢舉分類 → 看得懂的標籤。key 與 0057 的 check 約束逐字對應。 */
export const REASON_LABELS: Record<string, string> = {
  spam: "廣告洗版",
  abuse: "人身攻擊或騷擾",
  sexual: "情色或不當內容",
  selfharm: "自傷或輕生內容",
  privacy: "洩漏他人個資",
  other: "其他",
};

/** callback_data 有 64 bytes 上限，uuid 就佔 36——動詞與型別只能用單字母。
 *  mh=下架(moderate hide)、md=駁回(moderate dismiss)；p=貼文、c=回文。 */
export const modCallback = (action: "hide" | "dismiss", type: "post" | "comment", id: string) =>
  `${action === "hide" ? "mh" : "md"}:${type === "post" ? "p" : "c"}:${id}`;

export function parseModCallback(data: string):
  { action: "hide" | "dismiss"; type: "post" | "comment"; id: string } | null {
  const m = /^(mh|md):(p|c):([0-9a-f-]{36})$/.exec(data ?? "");
  if (!m) return null;
  return {
    action: m[1] === "mh" ? "hide" : "dismiss",
    type: m[2] === "p" ? "post" : "comment",
    id: m[3],
  };
}

// _shared/ecpay.ts — 綠界 ECPay 的簽章與參數組裝
//
// 這支只做三件事：算 CheckMacValue、組結帳參數、驗回呼。不碰資料庫、不碰業務邏輯，
// 所以它可以被離線測試——而金流最不能錯的就是簽章那一段，它必須測得到。
//
// 【CheckMacValue 是整個串接唯一會安靜失敗的地方】
//
// 算錯的話，綠界回的是「CheckMacValue Error」五個字，不會告訴你錯在哪一步：
// 是漏了參數、排序錯了、還是編碼的某一個字元不一樣。而下面那串 .NET 專屬的
// 字元替換，是最常被漏掉的一段——少一條，正常情況全都對，偏偏某些帶括號或
// 驚嘆號的商品名稱會失敗，而那種 bug 會在上線幾週後才出現一次。
//
// 驗回呼那一側更要緊：少了它，任何人都能對我們的端點 POST 一包
// 「RtnCode=1、付款成功」，然後拿到一個月的藏往。

const BASE = Deno.env.get("ECPAY_BASE") ?? "https://payment-stage.ecpay.com.tw";
export const ECPAY_CHECKOUT_URL = `${BASE}/Cashier/AioCheckOut/V5`;

const MERCHANT_ID = Deno.env.get("ECPAY_MERCHANT_ID") ?? "3002607";          // 綠界公開的測試帳號
const HASH_KEY    = Deno.env.get("ECPAY_HASH_KEY")    ?? "pwFHCqoQZGmho4w6";
const HASH_IV     = Deno.env.get("ECPAY_HASH_IV")     ?? "EkRm7iFT261dpevs";

export const ecpayConfigured = () =>
  !!(Deno.env.get("ECPAY_MERCHANT_ID") && Deno.env.get("ECPAY_HASH_KEY") && Deno.env.get("ECPAY_HASH_IV"));

/** 綠界的簽章是照 .NET 的 HttpUtility.UrlEncode（官方 PHP SDK 則是 urlencode）
 *  算的，而 JS 的 encodeURIComponent 與它們不完全一樣。
 *
 *  綠界文件列了一張替換表：%2d→- %5f→_ %2e→. %21→! %2a→* %28→( %29→)。
 *  那張表是寫給 PHP／.NET 看的——它們會把這幾個字編碼，所以要換回去。
 *  JS 本來就不編碼它們，所以照抄那張表在 JS 這邊全是空操作，兩邊結果相同。
 *
 *  ⚠ 真正的差異是替換表**沒有列到**的那兩個：
 *
 *      字元   JS encodeURIComponent   PHP/.NET urlencode（替換後）
 *      ~      ~（不編碼）              %7e
 *      '      '（不編碼）              %27
 *
 *  照抄替換表的實作會在這兩個字上與綠界算出不同的簽章，而平常完全正常——
 *  只有當網址或商品名剛好帶到 ~ 或單引號時才會突然「CheckMacValue Error」，
 *  且錯誤訊息不會告訴你是哪個字。所以這裡明確補編這兩個，不依賴預設行為。
 *
 *  空白是 + 不是 %20：urlencode 與 HttpUtility.UrlEncode 都是這樣。 */
export function dotNetUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/'/g, "%27")
    .replace(/~/g, "%7E")
    .toLowerCase()
    .replace(/%20/g, "+");
}

async function sha256Upper(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** 算 CheckMacValue。
 *
 *  步驟固定：①去掉 CheckMacValue 本身 ②鍵名不分大小寫排序 ③前後夾 HashKey／HashIV
 *  ④整串照 .NET 規則 URL 編碼並轉小寫 ⑤SHA256 ⑥轉大寫。
 *
 *  ②那一步要用「不分大小寫」排序：綠界的參數名是大寫開頭（MerchantID），
 *  而 ASCII 排序會把大寫全排在小寫前面。目前所有參數都是大寫開頭所以看不出差別，
 *  但只要有一個小寫參數混進來（例如日後的自訂欄位），就會安靜地算錯。 */
export async function checkMacValue(params: Record<string, string | number>): Promise<string> {
  return await sha256Upper(dotNetUrlEncode(macSource(params)));
}

/** 送去雜湊之前的那一串（未編碼）。獨立出來有兩個理由：
 *
 *  一、可測。簽章對不上時，98% 的原因在這一串的組法（排序錯、漏參數、HashKey
 *     與 HashIV 擺反），而不在 SHA256。把它攤開來就能逐字對著文件檢查，
 *     不必去猜一個 64 字的雜湊為什麼不一樣。
 *  二、可印。真的在線上撞到 CheckMacValue Error 時，把這一串印出來比對，
 *     是最快的一條路。
 *
 *  ⚠ 它含 HashKey 與 HashIV，等於把金鑰攤在眼前——只在本機除錯時印，
 *    絕不可寫進正式環境的日誌。 */
export function macSource(params: Record<string, string | number>): string {
  const entries = Object.entries(params)
    .filter(([k]) => k !== "CheckMacValue")
    .sort(([a], [b]) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  return `HashKey=${HASH_KEY}&` + entries.map(([k, v]) => `${k}=${v}`).join("&") + `&HashIV=${HASH_IV}`;
}

/** 驗回呼。綠界送來的那包必須自己簽得出同一個值，否則就是偽造的。
 *
 *  ⚠ 這一支的回傳值決定要不要把牒發出去。任何「驗不過就先放行」的分支都不能有——
 *    少了它，任何人都能對這個端點 POST 一包 RtnCode=1，拿到一個月的藏往。 */
export async function verifyCallback(params: Record<string, string>): Promise<boolean> {
  const got = String(params.CheckMacValue ?? "").toUpperCase();
  if (!got) return false;
  const want = await checkMacValue(params);
  // 時間恆定比對。這裡的時間差洩漏得很有限（攻擊者要猜的是 SHA256 的輸出），
  // 但簽章比對用 === 是一種會被抄去別處的壞習慣，不值得為了省三行而留著。
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** 綠界的時間格式：yyyy/MM/dd HH:mm:ss，而且是台北時間。
 *  用 UTC 送會被判成八小時前，落在某些「交易時間」檢核的邊界上會被退。 */
export function ecpayNow(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** 商店交易編號：限 20 字、只能英數。
 *
 *  不用 uuid：去掉連字號還有 32 字，超過上限。改成「時間＋亂數」，
 *  時間在前是為了讓它在綠界後台照時序排，對帳時找得到。 */
export function merchantTradeNo(prefix = "CW"): string {
  const t = Date.now().toString(36).toUpperCase();                 // 8 字上下
  const r = Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => b.toString(36).toUpperCase().padStart(2, "0").slice(-1)).join("");
  return (prefix + t + r).slice(0, 20);
}

export type PeriodOrder = {
  merchantTradeNo: string;
  amount: number;          // 每期金額（整數，綠界不收小數）
  itemName: string;        // 顯示在結帳頁的商品名
  tradeDesc: string;
  returnUrl: string;       // 首期結果（伺服器對伺服器）
  periodReturnUrl: string; // 之後每一期的結果（伺服器對伺服器）
  clientBackUrl?: string;  // 使用者按「返回商店」時導回哪裡（純前端，不可信）
  frequency?: number;      // 每幾個月扣一次，預設 1
  execTimes?: number;      // 總共扣幾期
};

/** 組定期定額的結帳參數（含簽章）。回傳的東西前端照原樣 POST 到 ECPAY_CHECKOUT_URL。
 *
 *  【為什麼不由後端直接轉址】綠界要的是 POST 一包表單，而 302 轉址只帶得動 GET。
 *  所以標準做法是後端把參數簽好交給前端，前端拿一個隱藏表單送出去。
 *  參數在前端手上會不會被改？會——所以金額與方案一律以我們自己資料庫那一列為準，
 *  回呼進來時重新比對，不採信綠界回傳的 TotalAmount 以外的任何業務欄位。 */
export async function buildPeriodCheckout(o: PeriodOrder): Promise<{ action: string; fields: Record<string, string> }> {
  const params: Record<string, string | number> = {
    MerchantID: MERCHANT_ID,
    MerchantTradeNo: o.merchantTradeNo,
    MerchantTradeDate: ecpayNow(),
    PaymentType: "aio",
    TotalAmount: Math.round(o.amount),
    TradeDesc: o.tradeDesc,
    ItemName: o.itemName,
    ReturnURL: o.returnUrl,
    ChoosePayment: "Credit",          // 定期定額只支援信用卡
    EncryptType: 1,                   // 1＝SHA256。不帶的話預設是 MD5，簽章會對不起來
    // ── 定期定額
    PeriodAmount: Math.round(o.amount),
    PeriodType: "M",                  // 以月為單位
    Frequency: o.frequency ?? 1,
    ExecTimes: o.execTimes ?? 12,     // 綠界月繳上限 99 期；先給 12，到期前再續約
    PeriodReturnURL: o.periodReturnUrl,
    ...(o.clientBackUrl ? { ClientBackURL: o.clientBackUrl } : {}),
  };
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) fields[k] = String(v);
  fields.CheckMacValue = await checkMacValue(params);
  return { action: ECPAY_CHECKOUT_URL, fields };
}

/** 回呼要怎麼處置。抽成純函式是為了測得到——這幾個分支每一個都對應到
 *  一種「錢進來了牒沒發」或「牒發了錢沒進來」，而它們在線上都不會叫。
 *
 *  ⚠ 這支**不驗簽章**。呼叫端必須先過 verifyCallback，再問這裡要做什麼。
 *    兩件事分開，是因為「這包是不是綠界送的」與「這包說了什麼」是兩個問題，
 *    混在一起寫的話，日後有人為了某個特例加一條 early return，很容易
 *    不小心繞過驗章那一步。 */
export type CallbackVerdict =
  | { act: "grant"; execTime: number }   // 發牒／延期
  | { act: "ignore"; why: string }       // 收下但不做事（回 1|OK，別再送）
  | { act: "fail"; why: string };        // 扣款失敗，標記訂單

export function classifyCallback(p: Record<string, string>): CallbackVerdict {
  // 綠界後台的「模擬付款」也會送一包真的回呼，RtnCode 同樣是 1。
  // 照著發牒的話，任何有後台權限的人都能無限發牒給自己。
  if (String(p.SimulatePaid ?? "0") === "1") return { act: "ignore", why: "SimulatePaid" };

  if (String(p.RtnCode ?? "") !== "1") {
    return { act: "fail", why: `${p.RtnCode ?? "?"} ${p.RtnMsg ?? ""}`.trim() };
  }

  // 這是第幾期。首期的回呼不一定帶 TotalSuccessTimes，沒有就當第 1 期。
  // ⚠ 這個數字是冪等的一半（另一半是綠界的交易編號）。它若算錯，
  //   同一期會被當成不同期記兩筆——靈石發兩次、牒延兩個月。
  const n = Number(p.TotalSuccessTimes ?? "");
  return { act: "grant", execTime: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1 };
}

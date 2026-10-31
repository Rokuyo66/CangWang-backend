// _shared/ip-limit.ts — 免認證端點（wall／post_list／post_detail）的每 IP 限流
//
// 【為什麼不用 rate_minute 那張表】
// services.ts 的 rateLimited() 是給 AI 請求用的：每次檢查都讀一次、寫一次資料庫。
// 套在免認證端點上，等於讓任何人每打一次就替我們多寫一列——限流本身變成放大器。
// 這三支都是唯讀、不花 AI 錢，要擋的只是「有人寫迴圈狂刷」，記在記憶體就夠。
//
// 【它擋得住什麼、擋不住什麼】
// Edge Function 會同時開好幾個 isolate、閒置就回收，所以這是「每個 isolate 各數各的」：
// 刷得兇的人會被分到幾個 isolate、上限實際是 N 倍。擋不住分散式攻擊（那要靠 Cloudflare），
// 擋得住單一來源的迴圈——那才是免費方案最常見、也最會燒掉資料庫額度的情況。
//
// 數字走環境變數：PUBLIC_RATE_PER_MIN（預設 60）。正常翻廣場一分鐘十幾次。

const PER_MIN = Number(Deno.env.get("PUBLIC_RATE_PER_MIN") ?? "60");
const WINDOW_MS = 60_000;
// 記憶體上限：超過就整批清掉重數。寧可讓一個刷的人多刷一輪，也不讓 isolate 被撐爆。
const MAX_KEYS = 5000;

const hits = new Map<string, { start: number; n: number }>();

/** 從請求標頭取來源 IP；取不到回 null（不限流，不擋人）。 */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null;
}

/** 這個 IP 這一分鐘是否超量。超量回 true。now 可注入，給測試用。 */
export function ipLimited(ip: string | null, now = Date.now(), perMin = PER_MIN): boolean {
  if (!ip || !(perMin > 0)) return false;
  let h = hits.get(ip);
  if (!h || now - h.start >= WINDOW_MS) {
    if (!h && hits.size >= MAX_KEYS) hits.clear();
    h = { start: now, n: 0 };
    hits.set(ip, h);
  }
  h.n++;
  return h.n > perMin;
}

/** 測試用：清掉計數。 */
export function _resetIpLimit() { hits.clear(); }

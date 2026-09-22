// _shared/prices.ts — 靈石價目。一份值，兩個來源，資料庫優先。
//
// 價目原本散在三支檔案的 const 裡（services.ts 四個、chat.ts 一個、interpret 一個），
// 於是「改一次價」＝改三支程式＋部署三支 function，而且前端還各自寫了一份給人看的數字。
// 摩擦一大，價就不會調——而上線後前三個月最該做的事就是調價。
//
// 這裡的規矩與 0043 的 model_prices、0058 的 plans 一致：價格是資料。
//
// 【讀不到資料庫時用預設，不是用 0】
//
// 下面 DEFAULTS 的值與 0059 的 insert 逐字相同。資料庫抖一下、或那張表還沒套用，
// 扣費照預設走——不會變成免費，也不會整個請求失敗。兩邊的值由
// dev/pricing-test.mts 釘在一起。
//
// 【為什麼是可變物件而不是 export const】
//
// 呼叫端有一半在同步的字串模板裡（webhook-tg 的選單文案）。若把價目改成 async
// 取用，那些地方全都要改成 async，而它們只是在組一行字。所以改成：每個請求開頭
// 呼叫一次 refreshPrices(db)（非同步、有快取、不拋），之後所有地方同步讀 COST。

export type PriceAction =
  | "extra_cast" | "followup" | "comment" | "deepen" | "chat" | "signin_mend" | "tts_reading";

/** 與 0059 的 insert 同值。改這裡也要改那裡，否則 dev/pricing-test.mts 會叫。 */
const DEFAULTS: Record<PriceAction, number> = {
  extra_cast: 10,   // 錨點：NT$0.63 ÷ 10 = 0.063／顆
  followup: 9,      // NT$0.56 ÷ 0.063
  comment: 8,       // NT$0.49 ÷ 0.063
  deepen: 34,       // NT$2.13 ÷ 0.063 —— 原 15，每顆 0.142，是免費石的套利出口
  chat: Number(Deno.env.get("LINGSHI_PER_CHAT") ?? "1"),
  signin_mend: 10,  // 非 AI 成本，純設計值
  // 朗讀不是 Anthropic 的帳，是 MiniMax 的：NT$4.16／次（hd 模型、約 1300 字）。
  // 換算到同一個錨點就是 66 顆——它比展開一次卦理（NT$2.13）還貴一倍。
  // 這不是溢價，是成本價；定得比它低，念得越多的人虧越多。
  tts_reading: 66,
};

/** 現行價目。同步讀。值由 refreshPrices() 更新，沒更新過就是 DEFAULTS。 */
export const COST: Record<PriceAction, number> = { ...DEFAULTS };

// 快取 60 秒。Edge Function 的實例會被重用，所以這是「每個實例每分鐘最多一次查詢」，
// 不是每個請求一次。調價後最慢一分鐘全站生效——不值得為了那一分鐘每請求查一次。
const TTL_MS = 60_000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

type Db = { from: (t: string) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> } };

/** 從資料庫載入價目。每個請求開頭呼叫一次即可。
 *
 *  ⚠ 這支永遠不拋。價目讀不到不是停止服務的理由——DEFAULTS 已經是對的值，
 *    讓一次資料庫抖動把使用者的「展開卦理」變成 500，比用舊價扣費糟得多。 */
export async function refreshPrices(db: unknown): Promise<void> {
  if (Date.now() - loadedAt < TTL_MS) return;
  if (inflight) return await inflight;          // 同一實例併發時只查一次
  inflight = (async () => {
    try {
      const { data, error } = await (db as Db).from("lingshi_prices").select("action, cost");
      if (error || !Array.isArray(data)) return;
      for (const row of data as { action: string; cost: number }[]) {
        // 只認得 DEFAULTS 裡有的鍵：資料庫多塞一列不會憑空長出一個價目，
        // 少一列則沿用預設（不會變成 undefined → NaN → 扣了 NaN 顆）
        if (row.action in COST && Number.isFinite(row.cost) && row.cost >= 0) {
          COST[row.action as PriceAction] = Math.round(row.cost);
        }
      }
      loadedAt = Date.now();
    } catch (e) {
      console.error("refreshPrices failed, 沿用預設價", e instanceof Error ? e.message : String(e));
    } finally {
      inflight = null;
    }
  })();
  await inflight;
}

/** 給前端與 TG 文案用的一包。前端不應自己寫死任何價格數字——
 *  寫死的那一份遲早會與這裡走散，而使用者看到的是寫死的那份。 */
export const priceTable = () => ({ ...COST });

/* ---------- 簽到獎勵（七日循環） ----------
 *
 * 【這裡原本有兩張不一樣的表】
 *
 * interpret 的是 [5,5,8,8,10,10,20]＝66 顆／週；webhook-tg 的是
 * [10,10,15,15,20,20,50]＝140 顆／週。兩邊寫的是同一個 profiles.last_sign_date，
 * 所以同一個人一天仍然只能簽一次——但他可以挑在哪裡簽。知道的人永遠走 TG，
 * 於是實際發石量是網頁版的 2.1 倍（283 顆／月 → 600 顆／月）。
 *
 * 換算成錢：以每顆 0.088 的平均兌現成本計，這一個差異讓每個免費帳號每月多花
 * NT$28（112.7 → 140.8）；若他把石頭全倒進深論，是多花 NT$45。
 *
 * 兩張表沒有人是故意寫成不一樣的——它就是「同一件事在兩個檔案各寫一份」的
 * 必然結果。所以合併成一份，兩邊都從這裡讀。取的是低的那張（網頁版）：
 * 發石量是成本，而簽到要的是「每天回來」這個習慣，不是石頭的絕對數量。
 *
 * 每一項是 [靈石, 好感]。第七天給大獎，這是七日循環的節奏點，不要抹平。
 * 2026-09-22 由 66 顆／週降為 40 顆（283 → 171 顆／月）。降的理由不是這筆錢本身
 * （171 顆的兌現成本是 NT$11，不是大數目），是它與訂閱的關係：觀微每月致贈 60 顆，
 * 而簽到白給 171 顆——簽七天拿到的比訂一個月還多，那會讓最低階的玉牒看起來沒有意義。
 *
 * 形狀保留：第七天仍是大獎（12 顆＋10 道緣），那是七日循環的節奏點。
 * 要再調就改這一行，兩邊同時生效。 */
export const SIGN_REWARDS: [number, number][] = [[3,0],[3,0],[5,5],[5,0],[6,0],[6,0],[12,10]];

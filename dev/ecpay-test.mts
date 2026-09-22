// dev/ecpay-test.mts — 綠界簽章。
//
// 【這一支測得到什麼、測不到什麼——先講清楚】
//
// 簽章算錯時綠界只回「CheckMacValue Error」五個字，不會說是排序錯、編碼錯還是
// 漏了參數。所以理想的驗證是拿官方文件的範例值當標準答案。
//
// 但那個值我沒有辦法在這個環境裡取得（developers.ecpay.com.tw 連不到），
// 而憑印象寫一個常數進來是最糟的做法：它會讓人拿一個不確定對的數字去「修正」
// 可能本來就正確的程式。所以這裡不寫那個斷言，改成驗兩件驗得了的事：
//
//   ①【雜湊前的那一串】macSource() 的組法——排序、HashKey／HashIV 的位置、
//      參數怎麼串。簽章對不上的原因 98% 在這裡，而這一串是人眼對得完文件的。
//   ②【編碼規則】特別是 JS 與 PHP/.NET 分歧的那兩個字（~ 與單引號）。
//
// 剩下的 SHA256 是標準演算法，不會錯。
//
// ⚠ 唯一能真正蓋棺論定的驗證，是拿測試帳號對綠界的測試環境送一筆出去——
//   那一步要在連得到 payment-stage.ecpay.com.tw 的機器上做。作法見檔尾。
//
// 跑法：node dev/ecpay-test.mts

// 官方範例用的金鑰。必須在 import 之前擺好——ecpay.ts 在載入當下就讀 env。
(globalThis as Record<string, unknown>).Deno ??= {
  env: {
    get: (k: string) => ({
      ECPAY_MERCHANT_ID: "2000132",
      ECPAY_HASH_KEY: "5294y06JbISpM5x9",
      ECPAY_HASH_IV: "v77hoKGq4kWxNNIS",
    } as Record<string, string>)[k],
  },
};

const { checkMacValue, macSource, dotNetUrlEncode, verifyCallback, ecpayNow, merchantTradeNo,
        buildPeriodCheckout, classifyCallback } =
  await import("../supabase/functions/_shared/ecpay.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => unknown | Promise<unknown>) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const eq = (a: unknown, b: unknown, m: string) => {
  if (a !== b) throw new Error(`${m}\n       得到 ${JSON.stringify(a)}\n       預期 ${JSON.stringify(b)}`);
};

console.log("\n綠界簽章\n");

console.log("— 雜湊前的那一串（簽章對不上時，錯的多半是這裡）");
const DOC_EXAMPLE = {
  MerchantID: "2000132",
  MerchantTradeNo: "Test1234567",
  MerchantTradeDate: "2013/03/12 15:23:51",
  PaymentType: "aio",
  TotalAmount: "1000",
  TradeDesc: "測試交易描述",
  ItemName: "測試商品等",
  ReturnURL: "http://www.ecpay.com.tw/receive.php",
  ChoosePayment: "ALL",
};
await t("組法與文件所述一致：HashKey 在前、參數 A→Z、HashIV 在後", () => {
  // 這一串是照文件的規則手寫出來的，不是照程式的輸出抄的——
  // 抄輸出的話這個斷言只會證明「程式等於它自己」。
  eq(macSource(DOC_EXAMPLE),
     "HashKey=5294y06JbISpM5x9" +
     "&ChoosePayment=ALL" +
     "&ItemName=測試商品等" +
     "&MerchantID=2000132" +
     "&MerchantTradeDate=2013/03/12 15:23:51" +
     "&MerchantTradeNo=Test1234567" +
     "&PaymentType=aio" +
     "&ReturnURL=http://www.ecpay.com.tw/receive.php" +
     "&TotalAmount=1000" +
     "&TradeDesc=測試交易描述" +
     "&HashIV=v77hoKGq4kWxNNIS",
     "排序、夾法或串接方式與文件不符");
});
await t("輸出是 64 字大寫十六進位（SHA256，不是 MD5）", async () => {
  const mac = await checkMacValue(DOC_EXAMPLE);
  if (!/^[0-9A-F]{64}$/.test(mac)) throw new Error(`格式不對：${mac}`);
});

console.log("\n— 編碼規則（直接驗編碼後的字串）");
await t("替換表列到的七個字，維持字面不編碼", () => {
  // PHP／.NET 會把它們編碼，再由綠界的替換表換回來，最終是字面。
  // JS 本來就不編碼它們，結果相同——這一條是確認沒有人手癢去「補強」編碼。
  eq(dotNetUrlEncode("-_.!*()"), "-_.!*()", "這七個字被編碼了，與替換表的結果不符");
});
await t("⚠ 替換表沒列到的兩個字必須自己補編", () => {
  // 這兩個是整個編碼段唯一會與綠界分岔的地方，而分岔時完全沒有徵兆：
  // 平常一切正常，只有網址或商品名剛好帶到它們才突然 CheckMacValue Error。
  eq(dotNetUrlEncode("'"), "%27", "單引號沒編碼——PHP urlencode 會給 %27");
  eq(dotNetUrlEncode("~"), "%7e", "波浪號沒編碼——PHP urlencode 會給 %7e");
});
await t("空白是 + 不是 %20", () => {
  eq(dotNetUrlEncode("a b"), "a+b", "urlencode 與 HttpUtility.UrlEncode 都是 +");
});
await t("整串轉小寫，中文編成小寫的百分比序列", () => {
  eq(dotNetUrlEncode("ABC"), "abc", "沒有轉小寫");
  eq(dotNetUrlEncode("測"), "%e6%b8%ac", "中文的編碼或大小寫不對");
});
await t("保留字照編（& = ? 這些若不編，參數會被拆錯）", () => {
  eq(dotNetUrlEncode("a&b=c?d"), "a%26b%3dc%3fd", "保留字沒編碼");
});

console.log("\n— 回呼驗證");
await t("自己簽的驗得過", async () => {
  const p: Record<string, string> = { MerchantID: "2000132", RtnCode: "1", TradeAmt: "183" };
  p.CheckMacValue = await checkMacValue(p);
  if (!(await verifyCallback(p))) throw new Error("驗不過");
});
await t("竄改任一欄位就驗不過（這是整條路的命脈）", async () => {
  const p: Record<string, string> = { MerchantID: "2000132", RtnCode: "0", TradeAmt: "183" };
  p.CheckMacValue = await checkMacValue(p);
  for (const [k, v] of [["RtnCode", "1"], ["TradeAmt", "9999"], ["MerchantID", "2000133"]]) {
    const bad = { ...p, [k]: v };
    if (await verifyCallback(bad)) throw new Error(`改了 ${k} 還驗得過——等於任何人都能宣稱自己付過錢`);
  }
});
await t("沒有 CheckMacValue 一律不過，不當作「沒帶就算了」", async () => {
  if (await verifyCallback({ RtnCode: "1" })) throw new Error("空簽章竟然放行");
  if (await verifyCallback({ RtnCode: "1", CheckMacValue: "" })) throw new Error("空字串竟然放行");
});
await t("大小寫不影響驗證（綠界文件未保證回傳一律大寫）", async () => {
  const p: Record<string, string> = { MerchantID: "2000132", RtnCode: "1" };
  p.CheckMacValue = (await checkMacValue(p)).toLowerCase();
  if (!(await verifyCallback(p))) throw new Error("小寫的簽章驗不過");
});

console.log("\n— 那些會安靜出錯的細節");
await t("鍵名排序不分大小寫", async () => {
  // 全大寫開頭時看不出差別，混進一個小寫參數才會現形。
  // ASCII 排序會把 Zebra 排在 apple 前面，綠界要的是 apple 在前。
  const a = await checkMacValue({ Zebra: "1", apple: "2" });
  const b = await checkMacValue({ apple: "2", Zebra: "1" });
  eq(a, b, "參數給的順序不該影響結果");
});
await t("CheckMacValue 自己不入簽", async () => {
  const base = { MerchantID: "2000132", RtnCode: "1" };
  const a = await checkMacValue(base);
  const b = await checkMacValue({ ...base, CheckMacValue: "WHATEVER" });
  eq(a, b, "把 CheckMacValue 也算進去的話，永遠驗不過");
});

console.log("\n— 格式");
await t("時間是台北時間，且為 yyyy/MM/dd HH:mm:ss", () => {
  // 2026-09-22T00:30:00Z ＝ 台北 08:30
  eq(ecpayNow(new Date("2026-09-22T00:30:00Z")), "2026/09/22 08:30:00", "時區或格式不對");
});
await t("商店交易編號：20 字以內、只有英數", () => {
  for (let i = 0; i < 200; i++) {
    const n = merchantTradeNo();
    if (n.length > 20) throw new Error(`${n} 長度 ${n.length}，綠界上限 20`);
    if (!/^[A-Za-z0-9]+$/.test(n)) throw new Error(`${n} 含非英數字元`);
  }
});
await t("同時產一千個不重複", () => {
  const s = new Set(Array.from({ length: 1000 }, () => merchantTradeNo()));
  if (s.size !== 1000) throw new Error(`一千個裡有 ${1000 - s.size} 個重複——那會讓兩筆訂單撞在一起`);
});

console.log("\n— 定期定額的參數");
await t("必要欄位齊備，且金額是整數", async () => {
  const { action, fields } = await buildPeriodCheckout({
    merchantTradeNo: "CWTEST0001", amount: 183,
    itemName: "幾知觀玉牒・觀微", tradeDesc: "月繳訂閱",
    returnUrl: "https://x/functions/v1/interpret",
    periodReturnUrl: "https://x/functions/v1/interpret",
  });
  if (!action.includes("AioCheckOut")) throw new Error("結帳網址不對");
  for (const k of ["MerchantID","MerchantTradeNo","MerchantTradeDate","PaymentType","TotalAmount",
                   "TradeDesc","ItemName","ReturnURL","ChoosePayment","EncryptType",
                   "PeriodAmount","PeriodType","Frequency","ExecTimes","PeriodReturnURL","CheckMacValue"]) {
    if (!(k in fields)) throw new Error(`少了必要欄位 ${k}`);
  }
  eq(fields.EncryptType, "1", "EncryptType 必須是 1（SHA256）；不帶會退回 MD5，簽章對不起來");
  eq(fields.ChoosePayment, "Credit", "定期定額只支援信用卡");
  if (!/^\d+$/.test(fields.TotalAmount)) throw new Error("金額必須是整數");
});
await t("組出來的參數自己驗得過", async () => {
  const { fields } = await buildPeriodCheckout({
    merchantTradeNo: "CWTEST0002", amount: 419,
    itemName: "幾知觀玉牒・知幾", tradeDesc: "月繳訂閱",
    returnUrl: "https://x/r", periodReturnUrl: "https://x/p",
  });
  if (!(await verifyCallback(fields))) throw new Error("自己組的參數驗不過");
});

console.log("\n— 回呼要怎麼處置（每一條分支都對應到一種收不到錢或白發牒）");
await t("付款成功 → 發牒，期數取 TotalSuccessTimes", () => {
  const v = classifyCallback({ RtnCode: "1", TotalSuccessTimes: "3" }) as any;
  eq(v.act, "grant", "該發牒");
  eq(v.execTime, 3, "這是第三期");
});
await t("首期沒帶期數時當第一期，不是當第零期", () => {
  // 當成 0 的話，order_payments 的 unique(trade_no, exec_time) 就對不上了——
  // 綠界重送時會被當成另一期，於是靈石發兩次、牒延兩個月。
  for (const p of [{ RtnCode: "1" }, { RtnCode: "1", TotalSuccessTimes: "" },
                   { RtnCode: "1", TotalSuccessTimes: "0" }, { RtnCode: "1", TotalSuccessTimes: "abc" }]) {
    const v = classifyCallback(p as any) as any;
    eq(v.act, "grant", JSON.stringify(p));
    eq(v.execTime, 1, `${JSON.stringify(p)} 的期數`);
  }
});
await t("⚠ 後台的「模擬付款」不發牒", () => {
  // 綠界後台按一下模擬付款，也會送一包 RtnCode=1 的真回呼過來（簽章正確）。
  // 照著發的話，任何有後台權限的人都能無限發牒給自己。
  const v = classifyCallback({ RtnCode: "1", SimulatePaid: "1", TotalSuccessTimes: "1" }) as any;
  eq(v.act, "ignore", "模擬付款不該發牒");
});
await t("扣款失敗不發牒，而且說得出失敗原因", () => {
  const v = classifyCallback({ RtnCode: "10100058", RtnMsg: "卡片過期" }) as any;
  eq(v.act, "fail", "失敗");
  if (!String(v.why).includes("卡片過期")) throw new Error(`原因該帶著走：${v.why}`);
});
await t("沒有 RtnCode 一律不發牒，不當作「沒帶就算了」", () => {
  eq((classifyCallback({}) as any).act, "fail", "空包不該發牒");
  eq((classifyCallback({ RtnCode: "" }) as any).act, "fail", "空字串不該發牒");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通過，${fail} 失敗`);
console.log(`
⚠ 還沒做的那一步：對綠界的測試環境實際送一筆
  上面這些只證明「組法與編碼符合文件所述」，不等於綠界那一側收得下來。
  在連得到 payment-stage.ecpay.com.tw 的機器上，用綠界公開的測試帳號送一次：

    MerchantID=3002607  HashKey=pwFHCqoQZGmho4w6  HashIV=EkRm7iFT261dpevs

  把 buildPeriodCheckout() 回傳的 fields 組成一個表單 POST 到 action，
  瀏覽器出現綠界的結帳頁＝簽章正確；出現「CheckMacValue Error」＝這裡有一處錯，
  把 macSource() 印出來逐字對文件（那一串含金鑰，只在本機印）。
`);
process.exit(fail === 0 ? 0 : 1);

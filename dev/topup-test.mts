// dev/topup-test.mts — 靈石儲值（一次付清）的組單與回呼判斷。
//
// 測的是兩支純函式：buildOneTimeCheckout（不可混進任何 Period* 欄位）與
// classifyOneTime（模擬付款／失敗／金額不符／成功）。資料庫那側的冪等
// （apply_lingshi_purchase 只發一次）在 SQL 裡，見檔尾的手動驗證步驟。
//
// 跑法：node dev/topup-test.mts

(globalThis as Record<string, unknown>).Deno ??= {
  env: {
    get: (k: string) => ({
      ECPAY_MERCHANT_ID: "3002607",
      ECPAY_HASH_KEY: "pwFHCqoQZGmho4w6",
      ECPAY_HASH_IV: "EkRm7iFT261dpevs",
    } as Record<string, string>)[k],
  },
};

const { buildOneTimeCheckout, classifyOneTime, checkMacValue, verifyCallback, merchantTradeNo } =
  await import("../supabase/functions/_shared/ecpay.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => unknown | Promise<unknown>) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const eq = (a: unknown, b: unknown, m: string) => {
  if (a !== b) throw new Error(`${m}\n       得到 ${JSON.stringify(a)}\n       預期 ${JSON.stringify(b)}`);
};

console.log("\n靈石儲值\n");

const ORDER = {
  merchantTradeNo: "LSTEST0001",
  amount: 150,
  itemName: "幾知觀・靈石一百六十顆",
  tradeDesc: "靈石儲值",
  returnUrl: "https://example.supabase.co/functions/v1/interpret?ecpay=return",
  clientBackUrl: "https://cangwang-web.pages.dev",
};

console.log("— 組單");
await t("⚠ 一次付清的單不帶任何 Period* 欄位（帶了綠界會當定期定額，下個月照扣）", async () => {
  const { fields } = await buildOneTimeCheckout(ORDER);
  const bad = Object.keys(fields).filter((k) => /^Period|^Frequency$|^ExecTimes$/.test(k));
  eq(bad.length, 0, `混進了 ${bad.join(",")}`);
});
await t("只開信用卡（離線付款的取號結果會被誤判成失敗）", async () => {
  const { fields } = await buildOneTimeCheckout(ORDER);
  eq(fields.ChoosePayment, "Credit", "ChoosePayment");
  eq(fields.EncryptType, "1", "EncryptType 必須是 1（SHA256）");
  eq(fields.PaymentType, "aio", "PaymentType");
  eq(fields.TotalAmount, "150", "TotalAmount 為整數字串");
});
await t("簽章自洽：送出去的那包自己驗得過", async () => {
  const { fields } = await buildOneTimeCheckout(ORDER);
  eq(await verifyCallback(fields), true, "自己簽的自己驗不過");
  const tampered = { ...fields, TotalAmount: "1" };
  eq(await verifyCallback(tampered), false, "改了金額還驗得過＝簽章沒罩到金額");
});
await t("CheckMacValue 是 64 字大寫十六進位", async () => {
  const { fields } = await buildOneTimeCheckout(ORDER);
  eq(/^[0-9A-F]{64}$/.test(fields.CheckMacValue), true, fields.CheckMacValue);
  eq(fields.CheckMacValue, await checkMacValue(fields), "重算要一致");
});
await t("單號：LS 開頭、≤20 字、只有英數", () => {
  for (let i = 0; i < 200; i++) {
    const n = merchantTradeNo("LS");
    if (!/^LS[0-9A-Z]{1,18}$/.test(n)) throw new Error(n);
  }
});

console.log("— 回呼判斷");
await t("成功：RtnCode=1、金額相符 → 發石", () => {
  eq(classifyOneTime({ RtnCode: "1", TradeAmt: "150", SimulatePaid: "0" }, 150).act, "grant", "應發石");
});
await t("⚠ 後台模擬付款不發石", () => {
  eq(classifyOneTime({ RtnCode: "1", TradeAmt: "150", SimulatePaid: "1" }, 150).act, "ignore", "模擬付款");
});
await t("⚠ 金額不符不發石", () => {
  eq(classifyOneTime({ RtnCode: "1", TradeAmt: "30" }, 150).act, "mismatch", "金額 30≠150");
  eq(classifyOneTime({ RtnCode: "1" }, 150).act, "mismatch", "沒帶 TradeAmt");
});
await t("授權失敗不發石，帶得出原因", () => {
  const v = classifyOneTime({ RtnCode: "10100058", RtnMsg: "卡片過期", TradeAmt: "150" }, 150) as any;
  eq(v.act, "fail", "失敗");
  if (!String(v.why).includes("卡片過期")) throw new Error(v.why);
});
await t("空包不發石", () => {
  eq(classifyOneTime({}, 150).act, "fail", "空包");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通過，${fail} 失敗`);
console.log(`
⚠ 資料庫側的冪等要在測試站手動驗一次（0117 套用後）：
  1. insert 一張 lingshi_orders（status=pending, amount=150, lingshi=160）
  2. select apply_lingshi_purchase(<id>, 'T1', 150);   → duplicate=false，ledger 多一列 lingshi_topup +160
  3. 同一行再跑一次                                   → duplicate=true，餘額不變
  4. 換一張單、p_amount 傳 1                          → 拋 LINGSHI_AMOUNT_MISMATCH，單仍是 pending
  端到端：用測試卡 4311-9511-1111-1111（任意未來期限、安全碼任意三碼、3D 簡訊 1234）刷一筆。
`);
process.exit(fail === 0 ? 0 : 1);

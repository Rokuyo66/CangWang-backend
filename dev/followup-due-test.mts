// dev/followup-due-test.mts — 追問補應期：<due> 標籤的解析與防呆。跑法：deno run -A dev/followup-due-test.mts
import { __followupTagged as tag, taipeiToday } from "../supabase/functions/_shared/services.ts";
let ok = 0, bad = 0;
const t = (n: string, c: boolean) => { c ? ok++ : (bad++, console.log("✗", n)); };
const future = new Date(Date.now() + 8 * 3600_000 + 20 * 86400_000).toISOString().slice(0, 10);
const past = "2020-01-01";

let r = tag(`亥月入令，十月中旬之後。\n<due>${future}</due>`);
t("取到未來日期", r.due === future);
t("正文剝掉標籤", !r.reading.includes("<due>") && r.reading.endsWith("之後。"));
t("null → null", tag("看時機。\n<due>null</due>").due === null);
t("早於今日作廢", tag(`<due>${past}</due>`).due === null);
t("今日可以", tag(`<due>${taipeiToday()}</due>`).due === taipeiToday());
t("格式不對作廢", tag("<due>十月中旬</due>").due === null);
t("沒有標籤 → null、正文原樣", (r = tag("就這樣。")).due === null && r.reading === "就這樣。");

// 反問與修正（0078）：標籤剝掉、null 認作沒有、三個標籤可並存
r = tag(`我先前以為你問錄不錄取。\n<due>null</due>\n<ask>你在意的是主管的人品，還是他對你的評價？</ask>\n<revise>null</revise>`);
t("取到反問", r.ask === "你在意的是主管的人品，還是他對你的評價？");
t("revise null → null", r.revision === null);
t("正文剝掉反問標籤", r.reading === "我先前以為你問錄不錄取。");
r = tag(`修正：原以為自占，其實是替妹妹問。\n<due>${future}</due>\n<ask>null</ask>\n<revise>自占→代占妹妹；結論由難成改為可成</revise>`);
t("取到修正", r.revision === "自占→代占妹妹；結論由難成改為可成");
t("修正時應期照取", r.due === future);
t("ask null → null", r.ask === null);
t("正文不留任何標籤", !/<\/?(due|ask|revise)>/.test(r.reading));
t("沒有標籤 → 兩個都 null", (r = tag("就這樣。")).ask === null && r.revision === null);
console.log(`${ok} 過 / ${bad} 敗`);

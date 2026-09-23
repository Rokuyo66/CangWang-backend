// dev/mail-test.mts — 站內信的規則。
//
// 這一支測的是 SQL 裡的幾條判斷，而它們都在 plpgsql／sql function 裡——
// 在 node 上跑不到。所以這裡測的是**規則的算術與字面**：把 0060／0061 的原文
// 讀進來，檢查那幾條關鍵的條件句還在。
//
// 【為什麼值得這樣測】
//
// 這幾條每一條都對應到一種「不會壞、只會錯」的狀況：
//
//   ・廣播的可見性少了 created_at 比較 → 新註冊的人一進來收到一疊舊信。
//     沒有錯誤、沒有例外，只是體驗莫名其妙，而且要有人回報才會發現。
//   ・下架通知寄給檢舉人而不是作者 → 把「誰檢舉了誰」的線頭遞出去。
//     那是隱私問題，而它看起來只是一個 user_id 寫錯。
//   ・生日信的判重沒了 → 排程重跑就寄第二封。一年一次的東西，
//     錯了要等一年才有下一次機會。
//
// 跑法：node dev/mail-test.mts

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const has = (src: string, re: RegExp, msg: string) => { if (!re.test(src)) throw new Error(msg); };

const MAIL = readFileSync("supabase/migrations/0060_mail.sql", "utf8");
const SEND = readFileSync("supabase/migrations/0061_mail_senders.sql", "utf8");
const IDX  = readFileSync("supabase/functions/interpret/index.ts", "utf8");
const DUE  = readFileSync("supabase/functions/due-reminder/index.ts", "utf8");
const GIFT = readFileSync("supabase/migrations/0063_mail_gift.sql", "utf8");
const MOON = readFileSync("supabase/migrations/0064_mail_midautumn_2026.sql", "utf8");
const TG   = readFileSync("supabase/functions/webhook-tg/index.ts", "utf8");

console.log("\n站內信\n");

console.log("— 廣播的可見性");
await t("廣播只寄給「寄出時已經註冊」的人", () => {
  // 少了這一條，今天註冊的人一進來就會看到過去所有的舊廣播——
  // 包含去年的生日信。那不是完整的歷史，是一疊他沒有份的舊信。
  const n = (MAIL.match(/m\.user_id is null and m\.created_at >= p\.created_at/g) ?? []).length;
  if (n < 2) throw new Error(`mail_list 與 mail_unread 都要有這一條，只找到 ${n} 處`);
});
await t("mail_mark 會先確認這個人看得到這封信", () => {
  const fn = /create or replace function mail_mark[\s\S]*?end \$\$;/.exec(MAIL);
  if (!fn) throw new Error("找不到 mail_mark");
  has(fn[0], /if not exists \([\s\S]*?from mail m[\s\S]*?\) then[\s\S]*?return;/,
    "mail_mark 沒有檢查呼叫端給的 mail id——函式不檢查參數是會被抄去別處的壞習慣");
});
await t("刪掉的信不再出現在清單裡", () => {
  has(MAIL, /s\.deleted_at is null/, "mail_list 沒有濾掉已刪的");
});
await t("已讀時間取最早那一次，不被後來的覆蓋", () => {
  has(MAIL, /read_at\s*=\s*coalesce\(mail_state\.read_at, excluded\.read_at\)/,
    "重複標已讀會把時間改成最後一次——那筆時間就失去意義了");
});

console.log("\n— 下架通知");
await t("信寄給作者，不是檢舉人", () => {
  // 告訴檢舉人處理結果，等於把「誰檢舉了誰」的線頭遞出去。
  has(SEND, /returning\s+user_id,[\s\S]{0,80}into v_author/, "貼文那一路沒有取出作者");
  has(SEND, /perform mail_send\(\s*v_author/, "寄信的對象不是 v_author");
  if (/mail_send\(\s*[a-z_]*report/.test(SEND)) throw new Error("看起來寄給了檢舉人");
});
await t("只有下架寄信，回復不寄", () => {
  // 回復是把東西還給他，再寄一封「你的貼文回來了」只會讓他重新想起這件事。
  has(SEND, /if p_hide and v_found > 0 and v_author is not null then/,
    "寄信的條件沒有同時包含「這次是下架」與「真的改了狀態」");
});
await t("信裡帶得出是哪一則（發過幾十篇的人要認得出來）", () => {
  has(SEND, /left\(coalesce\(title, body, ''\), \d+\)/, "貼文沒有取摘要");
  has(SEND, /v_what/, "信的內文沒有用到摘要");
});
await t("ref 指得回那一則，但不設外鍵", () => {
  // 貼文被刪之後，「你那篇被下架了」這句話仍然成立，信不該跟著消失。
  has(SEND, /'moderation', null, p_type, p_id/, "沒把 ref 帶進信裡");
  const tbl = /create table if not exists mail \([\s\S]*?\);/.exec(MAIL)![0];
  if (/ref_id\s+uuid\s+references/.test(tbl)) throw new Error("ref_id 設了外鍵——目標被刪時信會跟著消失");
});

console.log("\n— 角色生日");
await t("生日與信的內文都是資料，不是程式", () => {
  has(SEND, /alter table characters add column if not exists birthday text/, "生日沒落成欄位");
  has(SEND, /alter table characters add column if not exists birthday_letter text/, "信的內文沒落成欄位");
  // 寫死在 TS 裡的話，只有部署過的那一版知道今天是誰的生日，而信是排程寄的。
  if (/birthday\s*[:=]\s*["']\d{2}-\d{2}["']/.test(DUE)) throw new Error("due-reminder 裡寫死了生日");
});
await t("生日格式有約束（打錯就存不進去）", () => {
  has(SEND, /birthday\s*~\s*'\^\\\\d\{2\}-\\\\d\{2\}\$'|birthday ~ '\^\\d\{2\}-\\d\{2\}\$'/,
    "birthday 沒有格式檢查——存成 '3-3' 或 '2026-03-03' 都會安靜地永遠不觸發");
});
await t("判重看的是信本身，不另存旗標", () => {
  // 旗標與信總有不一致的那一天，而那天沒有人會發現。
  has(SEND, /not exists \(\s*select 1 from mail m/, "birthday_due 沒有判重");
  has(SEND, /m\.kind = 'character'/, "判重沒有限定角色信");
  has(SEND, /Asia\/Taipei/, "判重用的不是台北日界");
});
await t("生日信是一封廣播，不是每人一封", () => {
  // 一年三封信要為每個人各寫一列，那是把一封信做成一筆帳單。
  has(DUE, /mail_send[\s\S]{0,200}p_user:\s*null/, "生日信不是廣播");
});
await t("生日信寄不出去不會拖垮應期推播", () => {
  // 應期推播是每天都在跑的正事，生日信一年三次。
  const blk = /角色生日信[\s\S]*?catch \(e\)[\s\S]*?\}/.exec(DUE);
  if (!blk) throw new Error("生日那一段沒有包在 try/catch 裡");
});
await t("生日先寄，應期推播後跑", () => {
  // 反過來的話，某一次 TG 卡住就會把當天的生日信一起拖掉。
  const b = DUE.indexOf("birthday_due");
  const d = DUE.indexOf('from("feedback")');
  if (b < 0 || d < 0) throw new Error("找不到其中一段");
  if (b > d) throw new Error("生日信排在應期推播之後——TG 卡住會把生日信一起拖掉");
});

console.log("\n— 端點");
await t("信箱三支都在，且未讀數由 profile 一起帶回", () => {
  for (const m of ["mail_list", "mail_mark"]) {
    has(IDX, new RegExp(`body\\.mode === "${m}"`), `少了 ${m} 端點`);
  }
  has(IDX, /mailUnread:\s*Number\(/, "profile 沒帶未讀數——那要另打一支 API 才知道有沒有新信");
});
await t("清單筆數有上限（前端說幾筆就給幾筆會被人要一百萬筆）", () => {
  has(IDX, /Math\.min\(50,\s*Math\.max\(1,\s*Number\(body\.limit/, "mail_list 的 limit 沒有夾住");
  has(MAIL, /least\(p_limit, 100\)/, "SQL 那一側也該夾一次——兩道都上，不依賴呼叫端");
});

console.log("\n— 信裡夾靈石（0063）");
await t("收下是「改得到才發」，不是先查再發", () => {
  // 先 select 再 update 的話，兩支同時進來會各發一次。
  has(GIFT, /where user_id = p_user and mail_id = p_mail and claimed_at is null/, "update 沒有帶 claimed_at is null 的條件");
  has(GIFT, /get diagnostics v_n = row_count;\s*if v_n = 0 then/, "沒有用 row_count 判斷是不是這一支改到的");
  const upd = GIFT.indexOf("claimed_at is null;"), pay = GIFT.indexOf("apply_lingshi(p_user, 'mail_gift'");
  if (upd < 0 || pay < 0 || pay < upd) throw new Error("發靈石排在標記之前——判重就沒有意義了");
});
await t("收得到的信＝看得到的信（同 mail_mark 的可見性）", () => {
  has(GIFT, /\(m\.user_id = p_user\) or \(m\.user_id is null and m\.created_at >= p\.created_at\)/, "mail_claim 少了可見性判斷——拿別人的信 id 也收得到");
});
await t("清單帶出附了多少、收了沒，且仍濾掉刪除的信", () => {
  has(GIFT, /'lingshi', v\.lingshi/, "mail_list 沒帶 lingshi");
  has(GIFT, /'claimed', s\.claimed_at is not null/, "mail_list 沒帶 claimed");
  has(GIFT, /where s\.deleted_at is null/, "改寫 mail_list 時把刪除過濾弄丟了");
});
await t("舊的七參數 mail_send 先拿掉（不然具名呼叫會「不明確」）", () => {
  has(GIFT, /drop function if exists mail_send\(uuid, text, text, text, text, text, uuid\);/, "沒有 drop 舊版");
  has(GIFT, /grant execute on function mail_send\(uuid, text, text, text, text, text, uuid, int\) to service_role/, "新版沒有授權給 service_role");
});
await t("端點：mail_claim 在，/mail 認得第三段靈石", () => {
  has(IDX, /body\.mode === "mail_claim"/, "少了 mail_claim 端點");
  has(TG, /p_lingshi: gift/, "/mail 沒把靈石數交給 mail_send");
});
await t("中秋信：師妹寄、附 30、重跑不會寄第二封", () => {
  has(MOON, /'character', 'daoshi_f', null, null, 30/, "寄件人或靈石數不對");
  has(MOON, /if exists \([\s\S]*?subject = v_subject/, "沒有判重——重跑就寄第二封");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 過 / ${fail} 敗\n`);
process.exit(fail === 0 ? 0 : 1);

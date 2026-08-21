// dev/fake-db.mts — 記憶體版的 supabase-js 替身，只夠 case-run.ts 用。
//
// 為什麼要這個：卦案存檔那一層的規則（一人一案只准一局、行動要在 options 裡才算數、
// 記憶檔案配額、結案後不得再寫）全是伺服器邏輯，而驗這些東西不需要一個真的 Postgres。
// 有替身，這些規則就能在 `node dev/case-run-test.mts` 裡跑完，不必部署、不必連線。
//
// 刻意複製了兩件真資料庫的行為，因為漏掉哪一個，測出來的「過」都是假的：
//   1. 寫入 jsonb 會 JSON round-trip——存不進去的東西（undefined、Map、循環）當場現形；
//   2. case_runs_one_active 那條唯一索引，違反時吐 23505，而不是靜靜地開出第二局。
// 沒有實作的：RLS、trigger（updated_at 這裡手動蓋）、型別檢查、真正的 order by。

let seq = 0;
const uid = () => `row_${++seq}`;

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.rows = store[table] ??= [];
    this.filters = [];
    this.op = "select";
    this.payload = null;
    this.wantCount = false;
    this.headOnly = false;
    this.limitN = null;
  }

  select(_cols, opts) {
    // insert/update/delete 之後的 .select() 是「回傳寫入的列」，不是改成查詢
    if (this.op === "select") {
      if (opts?.count) this.wantCount = true;
      if (opts?.head) this.headOnly = true;
    }
    return this;
  }
  insert(v) { this.op = "insert"; this.payload = v; return this; }
  update(v) { this.op = "update"; this.payload = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col, val) { this.filters.push([col, val]); return this; }
  order() { return this; }
  limit(n) { this.limitN = n; return this; }

  match(r) { return this.filters.every(([c, v]) => r[c] === v); }

  run() {
    const hit = this.rows.filter((r) => this.match(r));
    switch (this.op) {
      case "select": {
        if (this.wantCount) return { data: null, count: hit.length, error: null };
        const out = this.limitN == null ? hit : hit.slice(0, this.limitN);
        return { data: clone(out), count: hit.length, error: null };
      }
      case "insert": {
        const row = { id: uid(), created_at: iso(), updated_at: iso(), ...jsonb(this.payload) };
        // case_runs_one_active：同一人同一案只准一局未結案
        if (this.table === "case_runs" && !row.ended &&
          this.rows.some((r) => r.user_id === row.user_id && r.case_id === row.case_id && !r.ended)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        this.rows.push(row);
        return { data: clone([row]), error: null };
      }
      case "update": {
        for (const r of hit) Object.assign(r, jsonb(this.payload), { updated_at: iso() });
        return { data: clone(hit), error: null };
      }
      case "delete": {
        for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
        return { data: clone(hit), error: null };
      }
    }
  }

  maybeSingle() {
    const { data, error, count } = this.run();
    if (error) return Promise.resolve({ data: null, error, count });
    return Promise.resolve({ data: data?.length ? data[0] : null, error: null, count });
  }
  single() {
    const { data, error, count } = this.run();
    if (error) return Promise.resolve({ data: null, error, count });
    if (!data?.length) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" }, count });
    return Promise.resolve({ data: data[0], error: null, count });
  }
  // 直接 await（沒有 single/maybeSingle）時走這裡
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
}

const iso = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 模擬寫進 jsonb 欄位：undefined 會消失、Date 會變字串、循環參照會炸 */
const jsonb = (v) => JSON.parse(JSON.stringify(v));

export function fakeDb(seed = {}) {
  const store = { ...seed };
  return { from: (t) => new Query(store, t), _store: store };
}

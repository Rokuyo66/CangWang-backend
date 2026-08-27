// dev/fake-db.mts — 記憶體版的 supabase-js 替身，只夠 case-run.ts 與計費那幾支用。
//
// 為什麼要這個：卦案存檔那一層的規則（一人一案只准一局、行動要在 options 裡才算數、
// 記憶檔案配額、結案後不得再寫）全是伺服器邏輯，而驗這些東西不需要一個真的 Postgres。
// 有替身，這些規則就能在 `node dev/case-run-test.mts` 裡跑完，不必部署、不必連線。
//
// 刻意複製了兩件真資料庫的行為，因為漏掉哪一個，測出來的「過」都是假的：
//   1. 寫入 jsonb 會 JSON round-trip——存不進去的東西（undefined、Map、循環）當場現形；
//   2. case_runs_one_active 那條唯一索引，違反時吐 23505，而不是靜靜地開出第二局；
//   3. apply_lingshi 扣成負數時是 raise（整支回捲），所以扣不動＝餘額原封不動。
// 沒有實作的：RLS、trigger（updated_at 這裡手動蓋）、型別檢查、真正的 join。
// order 支援多欄（連續呼叫 .order() 會疊成排序鍵，與 PostgREST 同）與 nullsFirst。
// 巢狀 select 支援一層，靠命名慣例推 FK（見 embedsOf）——夠心跡那幾支用，不是通用實作。

let seq = 0;
const uid = () => `row_${++seq}`;

/** 各表的主鍵欄位（upsert 要靠它判斷「這一列已經在了」）。未列者一律 id。 */
const PK = { free_quota: "key", profiles: "id", tg_sessions: "tg_id", cast_claims: "token" };

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.rows = store[table] ??= [];
    this.filters = [];
    this.orderBy = null;
    this.op = "select";
    this.payload = null;
    this.wantCount = false;
    this.headOnly = false;
    this.limitN = null;
    this.offsetN = 0;
  }

  select(cols, opts) {
    // insert/update/delete 之後的 .select() 是「回傳寫入的列」，不是改成查詢
    if (this.op === "select") {
      if (opts?.count) this.wantCount = true;
      if (opts?.head) this.headOnly = true;
      this.cols = cols;
    }
    return this;
  }
  insert(v) { this.op = "insert"; this.payload = v; return this; }
  upsert(v, opts) { this.op = "upsert"; this.payload = v; this.onConflict = opts?.onConflict; return this; }
  update(v) { this.op = "update"; this.payload = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  // is(col, null) 對到的是「沒有值」——undefined（欄位根本沒寫）也算，真資料庫裡兩者同義
  is(col, val) { this.filters.push((r) => val === null ? (r[col] ?? null) === null : r[col] === val); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  gte(col, val) { this.filters.push((r) => r[col] >= val); return this; }
  lte(col, val) { this.filters.push((r) => r[col] <= val); return this; }
  lt(col, val) { this.filters.push((r) => r[col] < val); return this; }
  not(col, op, val) { this.filters.push((r) => op === "is" && val === null ? (r[col] ?? null) !== null : r[col] !== val); return this; }
  // 連續呼叫會疊成多層排序鍵（PostgREST 就是這個語意）。舊版是後者覆蓋前者，
  // 於是 .order("status").order("last_cast_at") 只有後面那一個生效——
  // 心跡的時間軸正是這麼排的（open 在前、其中最近有卦的在上），覆蓋掉就測不出真實順序。
  order(col, opts) {
    (this.orderBy ??= []).push([col, opts?.ascending !== false, !!opts?.nullsFirst]);
    return this;
  }
  limit(n) { this.limitN = n; return this; }
  // .range(from, to) 是含頭含尾（PostgREST 語意）
  range(from, to) { this.offsetN = from; this.limitN = to - from + 1; return this; }

  match(r) { return this.filters.every((f) => f(r)); }

  /** 一層巢狀 select：把 "id, feedback(verdict)" 裡的 feedback(...) 撈出來掛上。
   *
   *  FK 用命名慣例推，兩個方向都認：
   *    這一列有 <單數>_id 欄位  → 往上找那一列（thread_notes.threads(title)）→ 回物件
   *    否則                     → 往下找 <本表單數>_id 指回來的列（casts.feedback(...)）→ 回陣列
   *  PostgREST 對一對一會回物件、一對多回陣列；這裡一律照上面的方向決定，
   *  所以讀的那一端該寫成「兩種都收」（心跡與 case-run 都是這麼寫的）。
   *  不支援：兩層以上、!inner、指定 FK 名稱、巢狀裡再加 filter。 */
  embed(row) {
    if (!this.cols || !this.cols.includes("(")) return row;
    for (const m of this.cols.matchAll(/(\w+)\s*\(([^()]*)\)/g)) {
      const name = m[1];
      const rows = this.store[name] ?? [];
      const parentKey = singular(name) + "_id";
      if (parentKey in row) {
        const hit = rows.find((r) => r.id === row[parentKey]);
        row[name] = hit ? clone(hit) : null;
      } else {
        const childKey = singular(this.table) + "_id";
        row[name] = clone(rows.filter((r) => r[childKey] === row.id));
      }
    }
    return row;
  }

  run() {
    const hit = this.rows.filter((r) => this.match(r));
    switch (this.op) {
      case "select": {
        if (this.wantCount) return { data: null, count: hit.length, error: null };
        if (this.orderBy) {
          hit.sort((a, b) => {
            for (const [col, asc, nullsFirst] of this.orderBy) {
              const x = a[col] ?? null, y = b[col] ?? null;
              if (x === y) continue;
              // null 的位置由 nullsFirst 決定，不參與大小比較——
              // 排序時把 null 當成空字串的話，"open"/"closed" 這種欄位會排出假的順序
              if (x === null) return nullsFirst ? -1 : 1;
              if (y === null) return nullsFirst ? 1 : -1;
              return (x < y ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
        }
        // MAX_ROWS：真的 PostgREST 一定會截（Supabase 的 db-max-rows 預設 1000），
        // 不模擬的話，「沒有分頁的 select」在測試裡永遠是對的，線上卻會少一截。
        const take = Math.min(this.limitN ?? MAX_ROWS, MAX_ROWS);
        const out = hit.slice(this.offsetN, this.offsetN + take);
        return { data: clone(out).map((r) => this.embed(r)), count: hit.length, error: null };
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
      case "upsert": {
        // 主鍵撞到就改寫、沒撞到就插入。真資料庫比對的是唯一索引，
        // 這裡以 onConflict（多欄以逗號分隔）或該表的主鍵為準。
        const keys = (this.onConflict ?? PK[this.table] ?? "id").split(",").map((k) => k.trim());
        const out = [];
        for (const v of [this.payload].flat()) {
          const row = jsonb(v);
          const exist = this.rows.find((r) => keys.every((k) => r[k] === row[k]));
          if (exist) { Object.assign(exist, row, { updated_at: iso() }); out.push(exist); }
          else { const fresh = { id: uid(), created_at: iso(), updated_at: iso(), ...row }; this.rows.push(fresh); out.push(fresh); }
        }
        return { data: clone(out), error: null };
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

/** 對齊 Supabase 的 db-max-rows：任何 select 最多回這麼多列 */
const MAX_ROWS = 1000;
const iso = () => new Date().toISOString();
/** 粗略單數化，只夠推 FK 欄名：threads→thread、casts→cast、feedback→feedback */
const singular = (t) => (t.endsWith("s") ? t.slice(0, -1) : t);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 模擬寫進 jsonb 欄位：undefined 會消失、Date 會變字串、循環參照會炸 */
const jsonb = (v) => JSON.parse(JSON.stringify(v));

/** 只實作 apply_lingshi，且照 0001_init.sql 的語意：餘額扣成負數就 raise，
 *  而 raise 會讓整個 function 回捲——所以扣不動時餘額必須原封不動，
 *  否則測出來的「靈石不足」會是一個已經被扣掉的假餘額。 */
function rpc(store, name, args) {
  if (name !== "apply_lingshi") return Promise.resolve({ data: null, error: { message: "unknown rpc: " + name } });
  const prof = (store.profiles ??= []).find((r) => r.id === args.p_user);
  if (!prof) return Promise.resolve({ data: null, error: { message: "no such user" } });
  const next = (prof.lingshi ?? 0) + args.p_amount;
  if (next < 0) return Promise.resolve({ data: null, error: { message: "INSUFFICIENT_LINGSHI" } });
  prof.lingshi = next;
  (store.ledger ??= []).push({ id: uid(), user_id: args.p_user, action: args.p_action, amount: args.p_amount, ref_id: args.p_ref ?? null, created_at: iso() });
  return Promise.resolve({ data: next, error: null });
}

/** Storage 的最小替身：list（用來查快取有沒有命中）、upload、getPublicUrl。
 *  只記到 store._files，測試因此看得見「這一次到底存了幾個檔」——
 *  快取有沒有真的省下一次合成，靠的就是這個數字，不是靠相信。 */
function fakeStorage(store) {
  const files = (store._files ??= new Map());
  return {
    from: (bucket) => ({
      list: (_prefix, opts = {}) => Promise.resolve({
        data: files.has(`${bucket}/${opts.search}`) ? [{ name: opts.search }] : [],
        error: null,
      }),
      upload: (path, bytes) => {
        files.set(`${bucket}/${path}`, bytes);
        return Promise.resolve({ data: { path }, error: null });
      },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://fake.local/${bucket}/${path}` } }),
    }),
  };
}

export function fakeDb(seed = {}) {
  const store = { ...seed };
  return {
    from: (t) => new Query(store, t),
    rpc: (n, a) => rpc(store, n, a),
    storage: fakeStorage(store),
    _store: store,
  };
}

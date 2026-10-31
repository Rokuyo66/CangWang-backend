// supabase/functions/studio-inbox/index.ts — 幾筆台 ↔ 企劃工作臺 的收件匣（表見 0111）
//
//   幾筆台（六六電腦）：POST push {items:[{task,round,col,doc_id,doc}]}   通過的稿推上來
//                       GET  rejects                                      拉工作臺的駁回
//                       POST rejects_ack {ids:[...]}                      排回重寫了（之後不再拉到）
//   企劃工作臺（Artifact）：GET  pull                                     還沒收的稿
//                       POST ack {ids:[...]}                              收進去了
//                       POST reject {task,text,col,doc_id}                駁回，帶意見回幾筆台
//
// 驗證：x-studio-key 標頭＝STUDIO_KEY（兩邊共用一把；工作臺存在六六自己瀏覽器的 localStorage）。
// 部署：supabase functions deploy studio-inbox --no-verify-jwt（工作臺沒有我們的 JWT）。

import { createClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("STUDIO_KEY") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const COLS = new Set(["letters", "chapters", "jianghu"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-studio-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

// 長度相同才逐字比，避免用 === 洩漏比對時間
function keyOk(got: string | null): boolean {
  if (!KEY || !got || got.length !== KEY.length) return false;
  let d = 0;
  for (let i = 0; i < KEY.length; i++) d |= KEY.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!keyOk(req.headers.get("x-studio-key"))) return json({ error: "unauthorized" }, 401);
  const action = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (action === "push" && req.method === "POST") {
    const items = Array.isArray(body.items) ? body.items : [];
    const rows = items
      .filter((x: any) => x && typeof x.task === "string" && Number.isInteger(x.round) && COLS.has(x.col)
        && typeof x.doc_id === "string" && x.doc && typeof x.doc === "object")
      .map((x: any) => ({ id: `${x.task}-r${x.round}`, task_id: x.task, round: x.round, col: x.col, doc_id: x.doc_id, doc: x.doc }));
    if (!rows.length) return json({ error: "no valid items" }, 400);
    // 同一輪重推不重複；已被工作臺收走的那列不動（ignoreDuplicates）
    const { error } = await db.from("studio_inbox").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: rows.map((r: any) => r.id) });
  }

  if (action === "pull" && req.method === "GET") {
    const { data, error } = await db.from("studio_inbox").select("id,task_id,round,col,doc_id,doc,created_at")
      .is("picked_at", null).order("created_at").limit(50);
    if (error) return json({ error: error.message }, 500);
    return json({ items: data });
  }

  if (action === "ack" && req.method === "POST") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x: unknown) => typeof x === "string").slice(0, 100);
    if (!ids.length) return json({ ok: [] });
    const { error } = await db.from("studio_inbox").update({ picked_at: new Date().toISOString() }).in("id", ids);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: ids });
  }

  if (action === "reject" && req.method === "POST") {
    const task = typeof body.task === "string" ? body.task.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
    if (!task || !text) return json({ error: "task and text required" }, 400);
    const { error } = await db.from("studio_rejects").insert({
      task_id: task, text, col: COLS.has(body.col) ? body.col : null,
      doc_id: typeof body.doc_id === "string" ? body.doc_id : null,
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "rejects" && req.method === "GET") {
    const { data, error } = await db.from("studio_rejects").select("id,task_id,text,col,doc_id,created_at")
      .is("consumed_at", null).order("created_at").limit(50);
    if (error) return json({ error: error.message }, 500);
    return json({ items: data ?? [] });
  }

  // 幾筆台排回重寫之後才標 consumed：拉了但當機沒排進去的，下次還拉得到
  if (action === "rejects_ack" && req.method === "POST") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x: unknown) => Number.isInteger(x)).slice(0, 100);
    if (!ids.length) return json({ ok: [] });
    const { error } = await db.from("studio_rejects").update({ consumed_at: new Date().toISOString() }).in("id", ids);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: ids });
  }

  return json({ error: "not found" }, 404);
}

Deno.serve(handle);

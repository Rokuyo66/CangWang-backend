"""工單：Claude（或其他成員）把 JSON 放進 ops/inbox/，值班照白名單執行、把結果寫到 ops/done/。

工單格式：
  {"from": "claude", "kind": "report", "text": "..."}                 推播給使用者
  {"from": "claude", "kind": "status", "summary": "...", "next": "..."}  更新巡檢狀態（不推播）
  {"from": "claude", "kind": "op", "op": "restart_ollama", "note": "..."}  執行白名單操作
"""
import asyncio
import os
import sys
import time

from .common import ROOT, load_config, log, read_json, save_state, write_json
from .team import CLAUDE_STATUS, DONE, INBOX

OPS = {
    "reload": "重新載入寫手台程式",
    "restart_ollama": "重啟 Ollama",
    "unload_models": "把模型移出記憶體（釋放顯卡／RAM）",
    "selftest": "跑自檢",
    "pause": "暫停寫稿",
    "resume": "恢復寫稿",
    "pull_model": "下載模型（限 config 的 allowed_pulls）",
    "abtest": "第二審模型 A/B 測試（背景執行，完成後通知）",
    "remove_model": "刪除模型（限 config 的 allowed_removes）",
}
BUTTON_OPS = ["reload", "restart_ollama", "unload_models", "selftest", "pause", "resume"]


async def _abtest(app, models, n, notify):
    from . import abtest
    from .common import load_state
    o = app.bot_data["ollama"]
    was_paused = load_state()["paused"]
    save_state(paused=True)
    try:
        while load_state().get("current"):  # 等手上那份寫完
            await asyncio.sleep(15)
        app.bot_data["abtest"] = f"準備中（{'、'.join(models)}）"
        await notify(app, f"🧪 A/B 測試開始：{'、'.join(models)}，寫稿暫停中。", sender="duty")

        async def prog(s):
            app.bot_data["abtest"] = s

        path, k = await abtest.run(o, models, n, prog)
        await notify(app, f"🧪 A/B 測試完成：{k} 份稿 × {len(models)} 個模型\n結果 logs/abtest/{path.name}\n"
                          f"等 🧠 Claude 評審。", sender="duty")
    except Exception as e:
        log.error("abtest 失敗：%s", e)
        await notify(app, f"🧪 A/B 測試失敗：{e}", sender="duty")
    finally:
        app.bot_data["abtest"] = None
        save_state(paused=was_paused)


async def _sh(*args, timeout=120):
    p = await asyncio.create_subprocess_exec(*args, cwd=str(ROOT), stdout=asyncio.subprocess.PIPE,
                                             stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill()
        return 124, "逾時"
    return p.returncode, out.decode(errors="replace")[-1500:]


async def run_op(app, op: str, args=None, notify=None) -> str:
    """執行白名單操作，回傳結果文字。reload 會在回傳後讓行程結束（systemd 自動重啟）。"""
    if op not in OPS:
        return f"❌ 不在白名單：{op}"
    o = app.bot_data["ollama"]
    if op == "pause":
        save_state(paused=True)
        return "⏸ 已暫停寫稿"
    if op == "resume":
        save_state(paused=False)
        return "▶️ 已恢復寫稿"
    if op == "unload_models":
        names = await o.ps()
        for m in names:
            await o.unload(m)
        return "已卸載：" + ("、".join(names) if names else "（本來就沒有）")
    if op == "restart_ollama":
        job = app.bot_data.get("job")
        if job and not job.done():
            job.cancel()
        code, out = await _sh("sudo", "-n", "systemctl", "restart", "ollama")
        if code == 0:
            return "✅ Ollama 已重啟"
        return "❌ 重啟失敗（多半是還沒授權，請在 WSL 跑一次 bash grant-ops.sh）：" + out[-300:]
    if op == "selftest":
        code, out = await _sh(sys.executable, "-m", "studio.selftest")
        return out[-1200:]
    if op == "pull_model":
        m = (args or {}).get("model", "")
        if m not in load_config().get("allowed_pulls", []):
            return f"❌ {m} 不在 allowed_pulls 白名單"
        status = await o.pull(m)
        return f"✅ {m} 下載完成（{status}）"
    if op == "remove_model":
        m = (args or {}).get("model", "")
        if m not in load_config().get("allowed_removes", []):
            return f"❌ {m} 不在 allowed_removes 白名單"
        r = await o.http.request("DELETE", f"{o.base}/api/delete", json={"model": m})
        return f"✅ 已刪除 {m}" if r.status_code < 300 else f"❌ 刪除失敗 {r.status_code}：{r.text[:200]}"
    if op == "abtest":
        a = args or {}
        models = [m for m in a.get("models", []) if m in load_config().get("allowed_pulls", []) + [load_config()["reviewer_model"]]]
        if not models:
            return "❌ 沒有可測的模型"
        asyncio.create_task(_abtest(app, models, int(a.get("n", 8)), notify))
        return f"已在背景開始（{'、'.join(models)}，{a.get('n', 8)} 份稿）"
    if op == "reload":
        asyncio.get_running_loop().call_later(2, os._exit, 0)
        return "♻️ 20 秒內重新上線"
    return "？"


async def poll(app, notify):
    """每 10 秒處理一次工單匣。"""
    from .team import who
    while True:
        for f in sorted(INBOX.glob("*.json")):
            try:
                msg = read_json(f) or {}
            except Exception as e:
                msg = {"kind": "bad", "error": str(e)}
            sender = who(msg.get("from", "claude"))
            kind = msg.get("kind")
            result = None
            try:
                if kind == "report":
                    await notify(app, msg.get("text", ""), sender=msg.get("from", "claude"))
                    result = "已推播"
                elif kind == "status":
                    write_json(CLAUDE_STATUS, {"last_at": time.time(), "summary": msg.get("summary", ""),
                                               "next": msg.get("next", "")})
                    result = "已記錄"
                elif kind == "op":
                    op = msg.get("op", "")
                    result = await run_op(app, op, msg.get("args"), notify)
                    await notify(app, f"依 {sender} 工單執行「{OPS.get(op, op)}」"
                                      + (f"（{msg['note']}）" if msg.get("note") else "") + f"\n→ {result}")
                else:
                    result = f"看不懂的工單：{msg}"
            except Exception as e:
                result = f"❌ 執行失敗：{e}"
                log.error("工單 %s 失敗：%s", f.name, e)
            write_json(DONE / f.name, {**msg, "result": result, "done_at": time.time()})
            f.unlink(missing_ok=True)
        await asyncio.sleep(10)

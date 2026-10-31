"""第二審模型 A/B 測試：同一批稿交給候選模型做因果檢查，結果給 Claude 評審。

由值班工單 {"kind":"op","op":"abtest"} 觸發；結果寫到 logs/abtest/<時間>.json
"""
import json
import time

from . import pipeline
from .common import DIRS, LOG_DIR, load_config, log, read_json, write_json

OUT_DIR = LOG_DIR / "abtest"
OUT_DIR.mkdir(exist_ok=True)


def pick_samples(n=8):
    """挑最近有稿的任務：待審、通過、捨棄都算，越新越先。"""
    files = []
    for st in ("pending", "approved", "rejected", "queue"):
        files += list(DIRS[st].glob("*.json"))
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for p in files:
        t = read_json(p)
        if t.get("rounds"):
            out.append(t)
        if len(out) >= n:
            break
    return out


async def run(o, models, n=8, progress=None):
    cfg = load_config()
    system = pipeline._system("causality.md")
    samples = pick_samples(n)
    result = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "models": models, "samples": []}
    path = OUT_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
    for i, t in enumerate(samples, 1):
        last = t["rounds"][-1]
        script = last["script"]
        entry = {"task_id": t["id"], "brief": t["brief"], "status": t.get("status"),
                 "script_text": pipeline.numbered_text(script),
                 "choices": script.get("choices", []), "foreshadow": script.get("foreshadow", []),
                 "baseline": {"model": last.get("models", {}).get("reviewer", cfg["reviewer_model"]),
                              "review": last["review"]},
                 "candidates": {}}
        user = ("【待審劇本（逐行）】\n" + entry["script_text"]
                + "\n\n【選項】\n" + json.dumps(entry["choices"], ensure_ascii=False)
                + "\n\n【本篇自稱的伏線】\n" + json.dumps(entry["foreshadow"], ensure_ascii=False))
        for m in models:
            if progress:
                await progress(f"🧪 {i}/{len(samples)} {m}")
            t0 = time.time()
            try:
                r = await o.chat(m, system, user, think=False, temperature=0.2,
                                 fmt=pipeline.REVIEW_SCHEMA, num_ctx=cfg["num_ctx"],
                                 num_predict=4096, num_thread=cfg.get("reviewer_num_thread"))
                try:
                    rv = pipeline.score_review(pipeline.extract_json(r["content"]))
                except ValueError:
                    rv = {"error": "輸出不是 JSON", "raw": r["content"][:1500], "done_reason": r.get("done_reason")}
                entry["candidates"][m] = {"review": rv, "secs": round(time.time() - t0, 1),
                                          "tokens": r.get("tokens")}
            except Exception as e:
                entry["candidates"][m] = {"error": f"{e.__class__.__name__}: {e}", "secs": round(time.time() - t0, 1)}
            log.info("abtest %s %s 完成 %.0fs", t["id"], m, time.time() - t0)
        result["samples"].append(entry)
        write_json(path, result)  # 邊跑邊存
    result["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    write_json(path, result)
    return path, len(samples)

"""本地助理：使用者在 TG 打一般文字時，由本地 Qwen 判斷意圖並呼叫工具。

Claude 額度不夠時，這是直接指揮本地端的入口。
"""
import json
import re

from .common import load_config, log

SYSTEM = """你是「幾知觀寫手台」的本地助理，負責替製作人（使用者）操作這套系統。
規則：
- 一律繁體中文，回答簡短（1–4 行），不寒暄。
- 能用工具完成的事就呼叫工具，不要只用嘴說。做完用一句話回報結果。
- 寫手台只寫三種：道緣信（letter）、道緣章（chapter）、江湖大綱（jh_outline）。使用者要排稿時呼叫 add_task；角色或章數不清楚就先問。
- 使用者給的劇情方向放進 add_task 的 brief。
- 問「在幹嘛」「進度」「誰在忙」時，呼叫 team_status 再摘要。
- 涉及寫程式、修 bug、改系統架構、終審劇本：回答「這要交給 Claude」，並建議使用者到 Claude 對話裡說。
- 不知道使用者要什麼就問一句，不要猜著亂做。
- 不可捏造任務 ID 或進度；所有狀態都要從工具結果來。"""


def tools_spec(job_keys, op_keys):
    def fn(name, desc, props=None, req=None):
        return {"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props or {}, "required": req or []}}}
    return [
        fn("team_status", "查看所有成員（寫手、審稿、Claude 巡檢等）目前在做什麼、佇列與排程狀態"),
        fn("add_task", "排一份稿進佇列。kind：letter 道緣信（角色＋道緣點，點可省略＝下一封）、chapter 道緣章（角色＋第幾章）、jh_outline 江湖大綱（卦號 1–64）",
           {"kind": {"type": "string", "enum": ["letter", "chapter", "jh_outline"]},
            "character": {"type": "string", "description": "大師兄／師妹／觀喵；江湖大綱留空"},
            "number": {"type": "integer", "description": "道緣點、章數或卦號"},
            "brief": {"type": "string", "description": "製作人補充的方向，可空"}}, ["kind"]),
        fn("list_pending", "列出待審稿"),
        fn("redo_task", "把一份稿退回重寫",
           {"task_id": {"type": "string"}, "reason": {"type": "string"}}, ["task_id"]),
        fn("set_writing", "暫停或恢復寫稿", {"on": {"type": "boolean"}}, ["on"]),
        fn("stop_current", "立刻中斷目前正在寫／審的那份（放回佇列並暫停）"),
        fn("set_job", "開關排程工作",
           {"job": {"type": "string", "enum": job_keys}, "on": {"type": "boolean"}}, ["job", "on"]),
        fn("run_op", "執行維運操作",
           {"op": {"type": "string", "enum": op_keys}}, ["op"]),
    ]


async def chat(o, history, text, handlers, job_keys, op_keys):
    """回傳 (回覆文字, 是否由模型回答)。history 會被就地更新（保留最近 8 則）。"""
    cfg = load_config()
    model = cfg.get("agent_model", cfg["writer_model"])
    msgs = [{"role": "system", "content": SYSTEM}, *history, {"role": "user", "content": text}]
    tools = tools_spec(job_keys, op_keys)
    try:
        for _ in range(4):
            m = await o.chat_raw(model, msgs, tools, timeout=cfg.get("agent_timeout", 90))
            calls = m.get("tool_calls") or []
            if not calls:
                reply = (m.get("content") or "").strip() or "（沒有回應）"
                history += [{"role": "user", "content": text}, {"role": "assistant", "content": reply}]
                del history[:-8]
                return reply, True
            msgs.append({"role": "assistant", "content": m.get("content", ""), "tool_calls": calls})
            for c in calls:
                f = c.get("function", {})
                name, args = f.get("name"), f.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                h = handlers.get(name)
                try:
                    out = await h(**args) if h else f"沒有這個工具：{name}"
                except Exception as e:
                    out = f"工具出錯：{e}"
                log.info("助理呼叫 %s(%s) → %s", name, args, str(out)[:120])
                msgs.append({"role": "tool", "content": str(out)[:3000], "tool_name": name})
        return "（步驟太多，先停在這裡。）", True
    except Exception as e:
        log.warning("本地助理失敗，改用關鍵字：%s", e)
        return await keyword_fallback(text, handlers, e), False


async def keyword_fallback(text, handlers, err):
    t = text
    if re.search(r"狀態|進度|在幹嘛|在做什麼|誰在", t):
        return await handlers["team_status"]()
    if re.search(r"立刻停|停止|中斷", t):
        return await handlers["stop_current"]()
    if re.search(r"暫停", t):
        return await handlers["set_writing"](on=False)
    if re.search(r"繼續|恢復|開工", t):
        return await handlers["set_writing"](on=True)
    if re.search(r"待審", t):
        return await handlers["list_pending"]()
    return (f"本地助理現在無法回應（{err.__class__.__name__}，多半是顯卡被佔用或 Ollama 沒開）。\n"
            "可用下方按鈕操作；要新增題目請用「題：」開頭。")

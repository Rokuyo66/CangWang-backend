"""Ollama REST 薄封裝。"""
import json
import re
import time

import httpx


class Ollama:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(3600, connect=10))

    async def chat(self, model, system, user, *, think=False, temperature=0.8,
                   fmt=None, num_ctx=16384, keep_alive="15m", num_thread=None,
                   num_predict=None, repeat_penalty=None):
        payload = {
            "model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "stream": False,
            "think": think,
            "keep_alive": keep_alive,
            "options": {"temperature": temperature, "num_ctx": num_ctx},
        }
        if num_thread:
            payload["options"]["num_thread"] = num_thread
        if num_predict:
            payload["options"]["num_predict"] = num_predict
        if repeat_penalty:
            payload["options"]["repeat_penalty"] = repeat_penalty
        if fmt is not None:
            payload["format"] = fmt
        t0 = time.time()
        r = await self.http.post(f"{self.base}/api/chat", json=payload)
        if r.status_code == 400 and "think" in r.text:
            payload.pop("think")  # 模型不支援思考模式
            r = await self.http.post(f"{self.base}/api/chat", json=payload)
        if r.status_code >= 400:
            raise RuntimeError(f"Ollama {r.status_code}（{model}）：{r.text[:500]}")
        d = r.json()
        msg = d.get("message", {})
        return {
            "content": msg.get("content", ""),
            "thinking": msg.get("thinking", ""),
            "secs": round(time.time() - t0, 1),
            "tokens": d.get("eval_count"),
            "done_reason": d.get("done_reason"),
        }

    async def chat_raw(self, model, messages, tools=None, *, timeout=120, **options):
        """給本地助理用：多輪訊息＋工具呼叫。回傳 message dict。"""
        payload = {"model": model, "messages": messages, "stream": False, "think": False,
                   "keep_alive": "30m", "options": {"temperature": 0.3, "num_predict": 800, **options}}
        if tools:
            payload["tools"] = tools
        r = await self.http.post(f"{self.base}/api/chat", json=payload, timeout=timeout)
        if r.status_code >= 400:
            raise RuntimeError(f"Ollama {r.status_code}：{r.text[:300]}")
        return r.json().get("message", {})

    async def pull(self, model):
        r = await self.http.post(f"{self.base}/api/pull", json={"model": model, "stream": False},
                                 timeout=httpx.Timeout(7200, connect=10))
        if r.status_code >= 400:
            raise RuntimeError(f"下載失敗 {r.status_code}：{r.text[:300]}")
        return r.json().get("status", "")

    async def unload(self, model):
        await self.http.post(f"{self.base}/api/generate", json={"model": model, "keep_alive": 0})

    async def tags(self):
        r = await self.http.get(f"{self.base}/api/tags")
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]

    async def ps(self):
        r = await self.http.get(f"{self.base}/api/ps")
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]


def extract_json(text: str):
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    a, b = text.find("{"), text.rfind("}")
    if a != -1 and b > a:
        return json.loads(text[a:b + 1])
    raise ValueError("模型輸出不是 JSON")

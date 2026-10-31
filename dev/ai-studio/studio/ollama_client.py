"""Ollama REST 薄封裝。"""
import asyncio
import json
import os
import re
import time

import httpx

# 模型名稱以 nim: 開頭＝走 NVIDIA build.nvidia.com 免費 API，例：nim:moonshotai/kimi-k2.6
NIM_PREFIX = "nim:"
NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions"


class Ollama:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(3600, connect=10))

    async def chat(self, model, system, user, *, think=False, temperature=0.8,
                   fmt=None, num_ctx=16384, keep_alive="15m", num_thread=None,
                   num_predict=None, repeat_penalty=None):
        if model.startswith(NIM_PREFIX):
            return await self._nim_chat(model[len(NIM_PREFIX):], system, user, think=think,
                                        temperature=temperature, fmt=fmt, num_predict=num_predict)
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

    async def _nim_chat(self, model, system, user, *, think, temperature, fmt, num_predict):
        """NVIDIA build.nvidia.com 的免費 API（OpenAI 相容）。設定 nvidia_api_key 或環境變數 NVIDIA_API_KEY。
        結構化輸出：NIM 不吃 Ollama 那種 JSON Schema，改成 json_object＋把 schema 寫進提示詞，解析照舊走 extract_json。"""
        from .common import load_config
        key = load_config().get("nvidia_api_key") or os.environ.get("NVIDIA_API_KEY")
        if not key:
            raise RuntimeError(f"要用 {NIM_PREFIX}{model} 得先在 config.json 填 nvidia_api_key")
        if fmt is not None:
            system += ("\n\n只輸出一個符合下列 JSON Schema 的 JSON 物件，不要 code block、不要說明文字：\n"
                       + json.dumps(fmt, ensure_ascii=False))
        payload = {"model": model, "temperature": temperature, "stream": False,
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                   "max_tokens": num_predict or 4096,
                   "chat_template_kwargs": {"thinking": bool(think), "enable_thinking": bool(think)}}
        if fmt is not None:
            payload["response_format"] = {"type": "json_object"}
        t0 = time.time()
        for attempt in range(4):
            r = await self.http.post(NIM_URL, json=payload, headers={"authorization": f"Bearer {key}"},
                                     timeout=httpx.Timeout(600, connect=15))
            if r.status_code == 400 and "response_format" in payload:
                payload.pop("response_format")       # 有些模型不收 json_object，靠提示詞＋extract_json
                continue
            if r.status_code == 429 and attempt < 3:  # 免費層每分鐘 40 次
                await asyncio.sleep(20 * (attempt + 1))
                continue
            break
        if r.status_code >= 400:
            raise RuntimeError(f"NVIDIA {r.status_code}（{model}）：{r.text[:500]}")
        d = r.json()
        ch = (d.get("choices") or [{}])[0]
        msg = ch.get("message") or {}
        content = re.sub(r"<think>[\s\S]*?</think>", "", msg.get("content") or "").strip()
        return {"content": content, "thinking": msg.get("reasoning_content") or "",
                "secs": round(time.time() - t0, 1), "tokens": (d.get("usage") or {}).get("completion_tokens"),
                "done_reason": "length" if ch.get("finish_reason") == "length" else ch.get("finish_reason")}

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

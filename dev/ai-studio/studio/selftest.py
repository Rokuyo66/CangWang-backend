"""安裝後自檢：python -m studio.selftest"""
import asyncio

import httpx

from .common import load_config
from .ollama_client import Ollama


async def main():
    cfg = load_config()
    ok = True
    o = Ollama(cfg["ollama_url"])
    try:
        tags = await o.tags()
        print("✅ Ollama 連線正常")
        for k in ("writer_model", "reviewer_model"):
            m = cfg[k]
            hit = m in tags or f"{m}:latest" in tags
            ok &= hit
            print(("✅" if hit else "❌"), k, m, "" if hit else "（未下載：ollama pull " + m + "）")
    except Exception as e:
        ok = False
        print("❌ 連不上 Ollama：", e)
    if cfg["telegram_token"]:
        r = httpx.get(f"https://api.telegram.org/bot{cfg['telegram_token']}/getMe", timeout=15)
        good = r.status_code == 200 and r.json().get("ok")
        ok &= bool(good)
        print(("✅ TG bot：@" + r.json()["result"]["username"]) if good else f"❌ TG token 無效：{r.text[:200]}")
    else:
        ok = False
        print("❌ 沒填 telegram_token")
    print("✅ admin_id", cfg["admin_id"]) if cfg["admin_id"] else print("❌ 沒填 admin_id")
    print("\n全部通過" if ok else "\n有項目沒過，請看上面")


if __name__ == "__main__":
    asyncio.run(main())

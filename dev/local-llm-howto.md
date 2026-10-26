# 本地 Ollama 接成線上最後備援

程式：`supabase/functions/_shared/local-llm.ts`。沒設 `LOCAL_LLM_URL` 就整層不存在，線上照舊。

```
閒聊：Haiku → Groq → NVIDIA → 本地 → 罐頭
解卦：主模型 → 備援（KIMI／Claude）→ 本地 → 丟錯
```

## 一、WSL 這邊（Ollama）

```bash
# 只聽本機就好，Tunnel 從本機轉出去；不要改成 0.0.0.0
sudo systemctl edit ollama
#   [Service]
#   Environment="OLLAMA_KEEP_ALIVE=30m"
#   Environment="OLLAMA_MAX_LOADED_MODELS=1"
sudo systemctl restart ollama
```

模型建議 `qwen3.5:9b`（6.6 GB，整顆進 VRAM）。ComfyUI 跑圖時會搶 VRAM，本地層失敗會自動往下掉，不用手動停。

## 二、開到外網：Cloudflare Tunnel ＋ Access（要有一個掛在 Cloudflare 的網域）

1. WSL 安裝並登入：
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
   sudo dpkg -i cf.deb && cloudflared tunnel login
   cloudflared tunnel create cangwang-llm
   cloudflared tunnel route dns cangwang-llm llm.<你的網域>
   ```
2. `~/.cloudflared/config.yml`：
   ```yaml
   tunnel: cangwang-llm
   credentials-file: /home/aiworker/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: llm.<你的網域>
       service: http://127.0.0.1:11434
       originRequest: { httpHostHeader: "localhost:11434" }
     - service: http_status:404
   ```
   `httpHostHeader` 不能省：Ollama 會擋 Host 不是 localhost 的請求（回 403）。
3. 常駐：`sudo cloudflared service install`
4. **加鎖（必做）**：Cloudflare Zero Trust →
   - Access → Service Auth → 建一組 Service Token，記下 Client ID／Secret（Secret 只顯示一次）
   - Access → Applications → Self-hosted，網域填 `llm.<你的網域>`，Policy 動作選 **Service Auth**，Include 選剛才那組 token
   - 驗證：不帶 token 去 curl 要回 403；帶了才通
     ```bash
     curl https://llm.<你的網域>/api/tags                       # 403
     curl https://llm.<你的網域>/api/tags -H "CF-Access-Client-Id: …" -H "CF-Access-Client-Secret: …"   # 列出模型
     ```

沒有網域的替代：Tailscale Funnel 加 Caddy 驗 Bearer，改設 `LOCAL_LLM_TOKEN`。

## 三、Supabase 這邊

```bash
supabase secrets set LOCAL_LLM_URL=https://llm.<你的網域> \
  LOCAL_CF_ID=… LOCAL_CF_SECRET=… LOCAL_LLM_MODEL=qwen3.5:9b
```

另跑 migration `0107_local_llm_price.sql`（本地呼叫記 0 元，不掉進 unpriced）。

| 變數 | 預設 | 說明 |
|---|---|---|
| `LOCAL_LLM_URL` | 空＝關 | Tunnel 網址 |
| `LOCAL_LLM_MODEL` | `qwen3.5:9b` | |
| `LOCAL_CF_ID`／`LOCAL_CF_SECRET` | | Access Service Token |
| `LOCAL_LLM_TOKEN` | | 走自架代理時的 Bearer |
| `LOCAL_CHAT_TIMEOUT_MS` | 15000 | 閒聊 |
| `LOCAL_INTERPRET_TIMEOUT_MS` | 60000 | 解卦（規則九千多 token，讀進去就要幾秒） |
| `LOCAL_KEEP_ALIVE` | 30m | 模型留在 VRAM 多久 |
| `LOCAL_DOWN_COOLDOWN_MS` | 120000 | 失敗一次後幾毫秒內不再去敲（電腦關機時不拖慢每一則） |

測試：`node dev/local-llm-test.mts`

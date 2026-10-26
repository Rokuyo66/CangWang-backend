# 本機部署清單（給六六電腦上的 Claude 照做）

六六只要對電腦上的 Claude 說：「照 `dev/RUNBOOK-local.md` 做完，每段做完回報一行結果；碰到『停下來』的條件就停。」

規則：
- 不要把任何 token、金鑰、密碼印到畫面或貼進對話。產生的金鑰直接寫進要用的地方。
- 每一段開頭先跑「檢查」，已經是好的就跳過那一段。
- 失敗就停在那一步，回報錯誤訊息（遮掉金鑰），不要自己改 SQL 或繞過去。

路徑：Windows `D:\cangwang`＝WSL `/mnt/d/cangwang`。幾筆台跑在 WSL 的 `/mnt/d/cangwang/ai-studio`（systemd 服務 `ai-studio`）。

---

## 一、拉最新

```powershell
cd D:\cangwang
git pull origin claude/kind-thompson-i29rtz
```
停下來：有衝突。

## 二、資料庫 migration（PowerShell 7：`pwsh`）

```powershell
.\dev\migrate.ps1 -Status
```
- 「待套用」應該只有 `0110_local_llm_price.sql`、`0111_studio_inbox.sql`。多了別的 → 停下來回報清單。
- `$env:SUPABASE_ACCESS_TOKEN` 沒設 → 停下來，請六六自己在這個視窗設（不要問 token 內容）。

```powershell
.\dev\migrate.ps1 -Apply      # 問確認時回 yes
```

## 三、收件匣（Edge Function studio-inbox）

檢查：`supabase secrets list --project-ref ajogafvzlhqwlxwkfcpn` 裡已經有 `STUDIO_KEY` 就跳過 1。

1. 產生金鑰、設成 secret、同時寫進幾筆台設定（金鑰不要印出來）：
   ```powershell
   $k = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
   supabase secrets set "STUDIO_KEY=$k" --project-ref ajogafvzlhqwlxwkfcpn
   $cfg = Get-Content ai-studio\config.json -Raw | ConvertFrom-Json
   $cfg | Add-Member -Force studio_key $k
   $cfg | Add-Member -Force studio_inbox_url "https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/studio-inbox"
   $cfg | ConvertTo-Json -Depth 10 | Set-Content ai-studio\config.json -Encoding utf8
   Set-Content -Path "$env:USERPROFILE\Desktop\studio-key.txt" -Value $k
   ```
   最後一行把金鑰放到桌面 `studio-key.txt`，六六要貼進工作臺用，貼完自己刪。
2. 部署：
   ```powershell
   supabase functions deploy studio-inbox --project-ref ajogafvzlhqwlxwkfcpn --no-verify-jwt
   ```
3. 驗證（回 401＝部署好、金鑰有在擋；404＝沒部署上）：
   ```powershell
   (Invoke-WebRequest -SkipHttpErrorCheck https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/studio-inbox/pull).StatusCode
   ```

## 四、幾筆台更新（WSL）

```bash
cd /mnt/d/cangwang
cp dev/ai-studio/studio/{pipeline,bot,selftest,team,sync}.py ai-studio/studio/
cp dev/ai-studio/prompts/final.md ai-studio/prompts/
```

`ai-studio/config.json` 補這幾個鍵（已經有的不動；用 python 改，別手打 JSON）：
```bash
cd /mnt/d/cangwang/ai-studio && python3 - <<'EOF'
import json; p='config.json'; c=json.load(open(p,encoding='utf-8'))
for k,v in {"final_reviewer_model":"qwen3:235b-a22b","final_pass_score":95,"round_cap_total":36,
            "second_reviewer_model":"gemma4:12b"}.items(): c.setdefault(k,v)
json.dump(c,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2); print("ok")
EOF
venv/bin/python -m studio.selftest
```
停下來：selftest 有 ❌（多半是模型沒下載）。

```bash
sudo systemctl restart ai-studio
```

## 五、Ollama 常駐設定（WSL）

檢查：`systemctl show ollama -p Environment` 已有 `OLLAMA_MAX_LOADED_MODELS=4` 就跳過。

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_MAX_LOADED_MODELS=4"\nEnvironment="OLLAMA_KEEP_ALIVE=60m"\n' | sudo tee /etc/systemd/system/ollama.service.d/cangwang.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```
（這會中斷正在寫的那一份稿，幾筆台會自動放回佇列重來。）

## 六、回報

一段一行：做了／跳過／停在哪一步。最後提醒六六：打開企劃工作臺 → 左上「📥 收件匣」→ 貼桌面 `studio-key.txt` 的金鑰 →「存並收一次」，看狀態列寫什麼。

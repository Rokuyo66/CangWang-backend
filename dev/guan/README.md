# 觀樞台（GUAN-00）

| 代號 | 名字 | 品牌字 | 職能 |
|---|---|---|---|
| ZHI-01 | 知錄台 | 知 | 信箱整理、產品訊息匯報、行政收發、會議紀要、待辦通知 |
| JI-02 | 幾筆台 | 幾 | 選題、起稿、改稿、標題、欄目風格、素材整理（`dev/ai-studio`） |
| **GUAN-00** | **觀樞台** | **觀** | 總機接待、來電分流、日程管理、跨機器人調度、每日總簡報 |

觀樞台跑在 Hermes Agent 上，接六六的自由輸入；另外兩台照舊是指令式。

```
六六 ──自由輸入──▶ 觀樞台 ──唯讀──▶ 幾筆台狀態（ji_status.py）
                     │      └─唯讀──▶ 知錄台狀態（zhi_status.py ← status.json）
                     └─工單（只限暫停／恢復）──▶ 幾筆台 ops/inbox
```

## 檔案

| 檔案 | 用途 |
|---|---|
| `persona.md` | 觀樞台的人格與鐵則，貼進 Hermes 的人格設定 |
| `tools/ji_status.py` | 幾筆台：總覽、`pending`、`night [小時]`、`stuck`，加 `--json` 給模型讀 |
| `tools/ji_ops.py` | 幾筆台：`pause`／`resume`（只開放這兩個） |
| `tools/zhi_status.py` | 知錄台：讀 `status.json` |
| `tools/brief.py` | 早安簡報（兩台合併） |
| `STATUS-CONTRACT.md` | 知錄台要寫出的狀態檔格式 |

工具只用 Python 標準庫，不 import 另外兩台的程式。

## 安裝（WSL）

1. Hermes 的模型用 `qwen3.5:35b-a3b`（回得快、工具呼叫穩）；235B 留給幾筆台晚上寫稿。
2. **另開一個 TG bot token**，不要跟幾筆台共用；白名單只放六六的 TG 帳號。
3. 人格：把 `persona.md` 貼進 Hermes 的人格設定（檔案位置以你安裝的 Hermes 版本文件為準）。
4. 工具：讓 Hermes 能執行 `python3 /mnt/d/cangwang/dev/guan/tools/*.py`。
   路徑不同就設環境變數 `JI_ROOT`（幾筆台）、`ZHI_STATUS`（知錄台狀態檔）。
5. 早安簡報：用 Hermes 的排程功能每天 07:00 跑 `brief.py` 推給六六。

## 安全（照做，不要省）

Hermes 會讀網頁、聽自由輸入，還能在電腦上執行指令；被網頁或信件裡藏的文字誤導的機會很高。
所以權限要用**檔案權限**鎖死，不能只靠人格設定裡的「請不要」：

```bash
sudo useradd -m guan                                      # 觀樞台用獨立帳號跑，不給 sudo
sudo chmod 600 /mnt/d/cangwang/ai-studio/config.json      # 幾筆台的 token 它讀不到
```

| 觀樞台可以 | 觀樞台不行 |
|---|---|
| 讀幾筆台的任務檔、state.json | 讀 `config.json`、`.env`、任何 token |
| 寫幾筆台 `ops/inbox`（只會送暫停／恢復） | 改幾筆台的程式、提示詞、設定 |
| 讀知錄台的 `status.json` | 讀信箱、讀信件原文 |

注意：`/mnt/d` 是 Windows 磁碟，WSL 預設不套用 Linux 權限。要讓 `chmod` 生效，
`/etc/wsl.conf` 要有：

```ini
[automount]
options = "metadata"
```

改完在 PowerShell 跑 `wsl --shutdown` 再開。

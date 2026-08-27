# 現況與更新紀錄（後端）

**開工前先讀這一份。** 前端那一半在 `Rokuyo66/CangWang-web`，它也有一份
同名的 `STATUS.md`——兩份各記各的 repo，交界的東西（API 契約）以
`dev/web/XINJI-API.md` 為準。

---

## 三條規矩

### 一、`main` 不一定是最新的。先 `git branch -r`

活的東西在功能分支上。`git clone --depth 1` 會連帶 `--single-branch`，
本機因此只有 `main`，看起來就像這個 repo 只有一條線——2026-08-27 就是這樣
在前端那邊白做了一份早就做好的功能。

```bash
git branch -r
git log --oneline -3 origin/main
```

### 二、做完就回頭補一筆

推上去之後在下面的「更新紀錄」加一行：日期／分支／commit／做了什麼。
細節留在 commit message 裡，不必在這裡重寫。

### 三、改契約就改 `dev/web/XINJI-API.md`，而且要說清楚前端要跟著改什麼

後端多回一個欄位不會讓前端壞，但**少回**一個會。前端接的是那份契約，
不是這裡的程式碼——契約與程式碼不一致的時候，是契約要改。

---

## 現在做到哪

| | |
|---|---|
| 活的分支 | `claude/voice-playback-feature-p9ebt8`（PR #36） |
| 對應的前端 | `CangWang-web` › 同名分支（APK `apk-b37`） |
| 未跑的 migration | `0049_voice_part_text.sql`、`0050_voice_from_chat.sql` |

**`0050` 真的加欄位**（`voice_clips.message_id`），沒跑的話閒聊收藏會壞。
`0049` 只改註解，不跑也不會壞，但註解是這張表唯一寫得下「parts 裡有什麼」的地方。

測試：`for f in dev/*-test.mts; do node "$f"; done`（十支，全過才算數）。

---

## 兩條鐵則（改東西之前先看一眼）

**客戶端只送「我做了什麼」，不送「我因此得到什麼」。** 朗讀只收 `cast_id`／`chat_id`，
念什麼由伺服器去 `casts`／`chat_messages` 撈。開放送文字＝把 MiniMax 金鑰做成公用
TTS，任何拿得到 JWT 的人都能拿它念小說，帳單記在觀主頭上。同一條也適用於額度、
用神、道緣進度：一律伺服器判定。

**這一層預設零 AI。** 心跡的時間軸、溫度線、角色留言、月誌統計全是查詢與純計算，
唯一呼叫模型的是月誌卷首語（每人每月一次）。理由不是省小錢：心跡要的是
「每天打開都有東西看」，而每天都有東西看又每次都要付錢的功能撐不住。
加新功能之前先問一次：這個非得過模型不可嗎。

（`CLAUDE.md` 在這個 repo 是 gitignore 的——刻意的，那是本機筆記。
所以會上線的規矩寫在這一份裡。）

---

## 更新紀錄（新的在上）

| 日期 | 分支 · commit | 做了什麼 |
|---|---|---|
| 2026-08-27 | `claude/voice-playback-feature-p9ebt8` | 契約更正：心跡與貼紙前端早就做完了，在 `claude/xinji-frontend` 上 |
| 2026-08-27 | 同上 | 閒聊那一句的 id 下發：`chat` 多回 `msg_id`、`chat_history` 每則多 `id`（排序改依 `id`） |
| 2026-08-27 | 同上 | 閒聊也念得了、收得了（`speakChat`、`voice_keep` 收 `chat_id`、migration `0050`）；閒聊 → 心跡 → 起卦（擬題標記多兩格、`chat` 多回 `xinji`、`xinji_open` 多收三個欄位） |
| 2026-08-27 | 同上 | 語音播放做完後半段：`parts[].text`／`ms`、`clip.peaks`、舊收藏補逐字稿（`castTexts`）、migration `0049` |

---

## 踩過的坑

**逐字稿不能亂配。** 補舊收藏的逐字稿時，認的是 `text_hash`（模型＋聲線＋原文），
段數對不上就整則放棄——把甲段的字配在乙段的聲音上，比沒有字更糟。

**朗讀只認 id，不收文字。** 客戶端送 `cast_id` 或 `chat_id`，念什麼一律伺服器
自己去撈；而且閒聊只念得了 `role='assistant'`。開放送文字＝把 MiniMax 金鑰做成
公用 TTS，帳單記在觀主頭上。

**額度換算只在後端做一次。** 前端不自己除（`left_readings` 直接用），
兩邊各除一次就會出現「這裡說 3 段、那裡說 2 段」。

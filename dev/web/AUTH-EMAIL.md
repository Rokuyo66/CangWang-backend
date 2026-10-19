# 認證信、重設密碼：Supabase 後台設定

前端（`CangWang-web` `src/main/09-auth.js`）已改成**驗證碼優先、連結也能用**。
程式只做了一半——下面四件要在 Supabase 後台（Authentication）手動設，**沒設的話驗證碼不會出現在信裡**。

## 現況（2026-10-19 已設好）

| 項目 | 設定 |
| --- | --- |
| 網頁網址 | `https://jizhiguan.com`（Cloudflare Pages 自訂網域；`cangwang-web.pages.dev` 仍可用） |
| 寄認證信 | Resend，寄件網域 `mail.jizhiguan.com`（DNS 由 Resend 自動寫進 Cloudflare），寄件人 `no-reply@mail.jizhiguan.com` |
| Supabase SMTP | `smtp.resend.com:465`，帳號 `resend`，密碼＝Resend API key（只在 Supabase 後台，不進 repo） |
| 信件範本 | Confirm signup、Reset Password 已加 `{{ .Token }}` |
| Site URL／Redirect URLs | `https://jizhiguan.com`（含 www、舊 pages.dev） |
| 客服信箱 | `support@jizhiguan.com`，Cloudflare Email Routing 轉寄到觀主 Gmail；Catch-all 關閉 |
| `ALLOWED_ORIGINS` | `https://jizhiguan.com,https://www.jizhiguan.com,https://cangwang-web.pages.dev,*.cangwang-web.pages.dev,https://localhost`（最後一個是 APK，不能漏） |

查信有沒有寄出去：Resend › Logs。查客服信有沒有轉到：Cloudflare › Email Routing › Activity log。

症狀對照（六六 2026-10-16）：

| 症狀 | 原因 | 對應 |
| --- | --- | --- |
| 信很慢才到 | 內建寄信服務：官方寫明「不適合正式上線」，只寄給組織成員、而且有頻率上限 | 一、自訂寄信服務 |
| 點了連結沒反應，其實已經通過，要回去重刷 | App 註冊、信裡連結開在瀏覽器；App 這一側沒有任何事件 | 前端已處理（自動重試登入）＋二、信裡附驗證碼 |
| 點連結顯示「已過期」 | 公司、學校信箱的掃描器先點掉了一次性連結 | 二、驗證碼不怕被掃 |

---

## 一、自訂寄信服務（SMTP）——收費前必做

Authentication › **Emails** › SMTP Settings › Enable custom SMTP。

- 服務商：Resend、Brevo、Postmark、AWS SES 都可以。量小的話免費額度就夠。
- **寄件網域用自己的網域**，並在 DNS 照服務商給的設好 **SPF、DKIM**（DMARC 也建議），不然 Gmail 會丟垃圾信匣。
- 寄件人名稱：`幾知觀`；寄件地址建議 `no-reply@你的網域`（客服信箱另外開，不要用這個收信）。
- 設好之後到 Authentication › **Rate Limits** 看一下「每小時寄信上限」（自訂 SMTP 後預設約 30），開賣前視流量調高。

## 二、信件範本：加上驗證碼

Authentication › **Emails** › Templates。兩封都要改，`{{ .Token }}` 是驗證碼、`{{ .ConfirmationURL }}` 是連結，兩個都留。

**Confirm signup**（主旨：`幾知觀・入觀驗證碼 {{ .Token }}`）

```html
<p>施主您好，</p>
<p>這是您的入觀驗證碼：</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700">{{ .Token }}</p>
<p>回到幾知觀，在「收信認證」那一頁輸入即可。</p>
<p>或直接點這裡完成認證（點完回到 App，會自動入觀）：<br>
<a href="{{ .ConfirmationURL }}">完成認證</a></p>
<p style="color:#888">不是您本人申請的話，忽略這封信即可。</p>
```

**Reset Password**（主旨：`幾知觀・重設密碼驗證碼 {{ .Token }}`）

```html
<p>施主您好，</p>
<p>這是您的重設密碼驗證碼：</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700">{{ .Token }}</p>
<p>回到幾知觀，在「重設密碼」那一頁輸入驗證碼與新密碼即可。</p>
<p>在網頁版也可以直接點這裡：<a href="{{ .ConfirmationURL }}">重設密碼</a></p>
<p style="color:#888">不是您本人申請的話，忽略這封信即可，密碼不會被改。</p>
```

主旨放驗證碼：手機通知列就看得到，不必打開信。

## 三、跳轉網址

Authentication › **URL Configuration**：

- **Site URL**：正式網頁版網址（不能是 `localhost`——App 註冊的人點連結會落在這裡）。
- **Redirect URLs** 加上正式網頁版網址。網頁版的註冊、重設密碼信會帶 `emailRedirectTo`／`redirectTo`＝目前這一頁；不在清單內的話會退回 Site URL。

## 四、驗證碼的效期與長度

Authentication › **Providers** › Email：

- Email OTP Expiration：建議 3600 秒（一小時）。信慢的時候太短會過期。
- Email OTP Length：6（前端收 6–10 碼）。

---

## 前端這一側做了什麼

- **收信認證頁**：輸入驗證碼就地入觀；點了信裡連結的人，回到 App（回前景、或每 8 秒）會用剛才的帳密自動再試一次登入，成功就進去，不必重整。最多試 15 分鐘。
- **重寄**：60 秒一次（同 Supabase 限制），按鈕上倒數。
- **忘記密碼**：填信箱 → 收驗證碼 → 輸入驗證碼＋新密碼 → 直接入觀。網頁版點重設連結回來，也會跳出「設定新密碼」。
- **道籍›設定**：顯示登入信箱、「變更密碼」、客服信箱。
- **客服信箱**：前端 `src/app/contact.js` 的 `SUPPORT_EMAIL`，全站只這一處（登入框底部、設定頁、退款政策）：`support@jizhiguan.com`。

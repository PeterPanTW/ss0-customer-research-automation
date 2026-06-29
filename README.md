# SS0 進單時自動查驗客人身分

> 當新詢問進入 Smartsheet 時，自動搜尋客人公開社群媒體與個人興趣，  
> 將 AI 摘要寫入「FB account link」欄，供業務開案前參考。

---

## ✅ 完成的事情

### 1. Smartsheet 欄位確認
- 取得工作表所有欄位的真實數字 ID（共 58 欄）
- 確認關鍵欄位：客人名稱、Email、國籍、FB account link、詢問者身分

### 2. 撰寫 Google Apps Script（`Code.gs`）
- 實作 `doPost()` 接收 Smartsheet Webhook 事件
- 自動過濾：只處理 `2C_` 開頭的一般消費者，跳過同業（2B）
- 呼叫 Claude API（含網路搜尋工具）查詢客人公開資料
- 將摘要寫回 Smartsheet 的「FB account link」欄

### 3. 部署 Google Apps Script 為 Web App
- 存取權設定為「任何人」（不需 Google 帳號）
- 讓 Smartsheet Webhook 驗證挑戰可以正常通過

### 4. 設定 Smartsheet Webhook
- 使用 Smartsheet API 建立並啟用 Webhook
- 監聽工作表的新增列（`row.created`）事件
- Webhook 狀態：`ENABLED`

### 5. 端到端測試通過
- 測試客人：Erez Shimoni（SS0_06669，以色列籍家庭旅遊）
- AI 成功找到：LinkedIn、Instagram (@mortgagesbyerez)、Facebook 粉絲頁
- 摘要包含：旅遊風格、個人興趣、社群媒體發現、業務建議
- 結果已正確寫入「FB account link」欄

### 6. 整理資料結構
- 原先另建「AI 背景調查」欄 → 決定改用原有「FB account link」欄
- 刪除多餘欄位，保持原本資料結構不變
- 更新 `Code.gs` 中的目標欄位 ID

---

## ⚠️ 要留意的內容

### Google Apps Script 部署
- **存取權必須選「任何人」**，不是「任何擁有 Google 帳號的人」
  - 錯誤設定 → Smartsheet 驗證時收到 302 重導向到 Google 登入頁 → `DISABLED_VERIFICATION_FAILED`
- Web App 的 POST 請求正常情況下會先 302 重導向到 `script.googleusercontent.com`，這是 Google 正常行為，不代表出錯

### Smartsheet Webhook 設定
- `events` 欄位必須使用字串格式：`["*.*"]`
  - ❌ `[{"objectType": "row", "eventType": "created"}]`（物件格式會被拒絕）
  - ✅ `["*.*"]`（接受全部事件，在 Apps Script 內再過濾）
- 驗證失敗後狀態為 `DISABLED_VERIFICATION_FAILED`，需刪除重建，無法直接修復
- Webhook ID 記錄在 `Code.gs` 的 `setupWebhook()` 函式註解中

### Claude API 網路搜尋
- 同名人士問題：Claude 搜尋時可能找到多個同名者，需在 Prompt 提供足夠辨識資訊（國籍、Email domain）
- 網路搜尋最多 5 次（`max_uses: 5`），可依需求調整
- 需在 request header 加入：`anthropic-beta: web-search-2025-03-05`

### 費用估算
| 月詢問量（2C） | 預估費用 |
|---|---|
| 100 筆 | ~$7 USD（約 NT$230）|
| 150 筆 | ~$10 USD（約 NT$330）|
| 200 筆 | ~$14 USD（約 NT$460）|

- Google Apps Script：免費（每日執行時間遠低於 6 分鐘上限）
- Smartsheet Webhook：免費

### 資料位置
- AI 摘要輸出欄：**FB account link**（第 28 欄）
- Smartsheet 工作表：`0 客製化訂單 詢問總攬`

---

## 🛠️ Skill（使用技術）

### Smartsheet MCP / API
- `get_columns`：取得所有欄位的真實數字 ID
- `add_columns`：新增自訂欄位
- `delete_column`：刪除多餘欄位
- `update_rows`：將 AI 結果寫回指定儲存格
- REST API（PowerShell）：建立並啟用 Webhook

### Google Apps Script
- `doPost(e)`：接收外部 POST 請求（Webhook 進入點）
- Smartsheet 驗證挑戰處理：偵測 `body.challenge` 並回傳 `smartsheetHookResponse`
- `UrlFetchApp.fetch()`：呼叫外部 API（Smartsheet、Claude）
- `Utilities.sleep()`：等待 Smartsheet 資料完整寫入後再讀取

### Claude API（Anthropic）
- 模型：`claude-sonnet-4-6`
- 工具：`web_search_20250305`（網路搜尋）
- Beta header：`web-search-2025-03-05`
- Prompt 設計：提供客人資料 + 明確搜尋重點 + 指定輸出格式

### PowerShell（Smartsheet API 操作）
- 建立 Webhook：`POST /2.0/webhooks`
- 啟用 Webhook：`PUT /2.0/webhooks/{id}`
- 刪除 Webhook：`DELETE /2.0/webhooks/{id}`
- 注意：JSON body 需使用原始字串，不可透過 `ConvertTo-Json` 處理包含陣列的巢狀結構

### 架構設計
- Smartsheet Webhook → Google Apps Script（doPost）→ Claude API（web search）→ Smartsheet（update row）
- 身分過濾：`詢問者身分` 欄以 `2C_` 開頭才處理，其餘跳過
- 錯誤保護：`muteHttpExceptions: true` + null check

---

## 📁 檔案說明

| 檔案 | 說明 |
|------|------|
| `Code.gs` | Google Apps Script 完整程式碼 |
| `README.md` | 本文件 |

> ⚠️ `Code.gs` 中的 API Token 欄位（`ANTHROPIC_API_KEY`、`SMARTSHEET_TOKEN`）請勿上傳至公開 repo。

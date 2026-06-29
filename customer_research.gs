// ============================================================
// 客人背景自動調查 - Google Apps Script
// 流程：Smartsheet 新進單 → Webhook → Claude 搜尋 → 寫回 Smartsheet
// ============================================================

// ===== 1. 填入你的設定 =====
const CONFIG = {
  ANTHROPIC_API_KEY: 'YOUR_ANTHROPIC_API_KEY',   // → console.anthropic.com 取得
  SMARTSHEET_TOKEN:  'YOUR_SMARTSHEET_TOKEN',    // → Smartsheet 右上角頭像 > Personal Access Tokens
  SHEET_ID:          '3025765638924164', // 已填入
  RESEARCH_COLUMN_ID: '3711617893459844', // FB account link 欄位（AI 結果寫入此欄）
};

// ===== 2. 欄位 ID 對照表（已自動填入）=====
const COLUMNS = {
  '客人名稱':           '2725104976193412',
  'Email address':      '7228704603563908',
  'Nationality':        '1599205069350788',
  'FB account link':    '3711617893459844',
  '[Special need and care]': '1356762755426180',
  'When you travel, what are the most important eleme': '5860362382796676',
  '詢問者身分':          '4561864401571716',
};

// ============================================================
// 初始設定
// ✅ Step A：欄位 ID 已自動填入 COLUMNS
// ✅ Step B：「AI 背景調查」欄位已建立（ID: 661972303777668）
// 🔲 Step C：部署 Web App 後執行 setupWebhook()
// 🔲 Step D：填入 ANTHROPIC_API_KEY 和 SMARTSHEET_TOKEN 後測試
// ============================================================

// Step A（已完成）：取得所有欄位 ID
function getColumnIds() {
  const url = `https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}/columns`;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}` }
  });
  const cols = JSON.parse(res.getContentText()).data;
  cols.forEach(c => Logger.log(`'${c.title}': '${c.id}',`));
}

// Step B（已完成）：在 Smartsheet 新增「AI 背景調查」欄位
function addResearchColumn() {
  const url = `https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}/columns`;
  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      title: 'AI 背景調查',
      type:  'TEXT_NUMBER',
      index: 29  // 放在 FB account link 後面
    })
  });
  const data = JSON.parse(res.getContentText());
  const newId = data.result[0].id;
  Logger.log(`新欄位 ID：${newId}`);
  Logger.log('請把此 ID 填入 CONFIG.RESEARCH_COLUMN_ID');
}

// Step C：部署 Web App 後，把 URL 貼入此函式再執行，建立 Webhook
function setupWebhook() {
  const webAppUrl = 'https://script.google.com/macros/s/AKfycbz5SRfL8lDHmv8tUVk1lN7lXRHQsZRzh7YgkL6aoYPGKowoUyog3y9sqChX9t12XR0/exec';
  // Webhook ID: 2351325464815492  狀態: ENABLED ✅

  const res = UrlFetchApp.fetch('https://api.smartsheet.com/2.0/webhooks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      name:          '新詢問自動背景調查',
      callbackUrl:   webAppUrl,
      scope:         'sheet',
      scopeObjectId: CONFIG.SHEET_ID,
      events:        [{ objectType: 'row', eventType: 'created' }],
      version:       1
    })
  });
  const result = JSON.parse(res.getContentText());
  const webhookId = result.result.id;
  Logger.log(`Webhook ID：${webhookId}`);

  // 啟用 Webhook
  UrlFetchApp.fetch(`https://api.smartsheet.com/2.0/webhooks/${webhookId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ enabled: true })
  });
  Logger.log('Webhook 已啟用！');
}

// Step D：用現有資料測試（填入任一 Row ID 執行）
function testWithRow() {
  const testRowId = '2063130630487940'; // 替換為你想測試的 Row ID
  processNewRow(testRowId);
}

// ============================================================
// Webhook 接收器（Smartsheet 呼叫這裡）
// ============================================================

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // Smartsheet 驗證挑戰（啟用 Webhook 時發生一次）
    if (body.challenge) {
      return ContentService
        .createTextOutput(JSON.stringify({ smartsheetHookResponse: body.challenge }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 處理新進單事件
    if (body.events) {
      body.events.forEach(event => {
        if (event.eventType === 'CREATED' && event.objectType === 'ROW') {
          Utilities.sleep(2000); // 等待 Smartsheet 資料完整寫入
          processNewRow(event.id);
        }
      });
    }

    return ContentService.createTextOutput('OK');
  } catch (err) {
    Logger.log('doPost error: ' + err);
    return ContentService.createTextOutput('Error: ' + err.message);
  }
}

// ============================================================
// 核心邏輯
// ============================================================

function processNewRow(rowId) {
  const row = getRow(rowId);
  if (!row) { Logger.log('Row not found: ' + rowId); return; }

  // 只處理 2C（一般消費者），跳過同業
  const identity = getCellValue(row, '詢問者身分');
  if (identity && !identity.startsWith('2C')) {
    Logger.log(`跳過同業詢問 (${identity})`);
    return;
  }

  const name        = getCellValue(row, '客人名稱');
  if (!name) { Logger.log('無客人名稱，跳過'); return; }

  const email       = getCellValue(row, 'Email address');
  const nationality = getCellValue(row, 'Nationality');
  const fbLink      = getCellValue(row, 'FB account link');
  const special     = getCellValue(row, '[Special need and care]');
  const interests   = getCellValue(row, 'When you travel, what are the most important eleme');

  Logger.log(`開始調查：${name} (${email})`);

  const summary = researchWithClaude(name, email, nationality, fbLink, special, interests);
  writeToSmartsheet(rowId, summary);

  Logger.log('完成！');
}

// ============================================================
// Smartsheet API 工具函式
// ============================================================

function getRow(rowId) {
  const url = `https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}/rows/${rowId}`;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}` },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  return JSON.parse(res.getContentText());
}

function getCellValue(row, columnTitle) {
  const colId = COLUMNS[columnTitle];
  if (!colId || !row.cells) return '';
  const cell = row.cells.find(c => String(c.columnId) === String(colId));
  return (cell && cell.value != null) ? String(cell.value) : '';
}

function writeToSmartsheet(rowId, text) {
  if (!CONFIG.RESEARCH_COLUMN_ID) {
    Logger.log('請先執行 addResearchColumn() 並填入 RESEARCH_COLUMN_ID');
    return;
  }
  UrlFetchApp.fetch(`https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}/rows`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify([{
      id: rowId,
      cells: [{ columnId: CONFIG.RESEARCH_COLUMN_ID, value: text }]
    }]),
    muteHttpExceptions: true
  });
}

// ============================================================
// Claude API（含網路搜尋）
// ============================================================

function researchWithClaude(name, email, nationality, fbLink, special, interests) {
  const prompt = `你是台灣私人旅遊公司的業務助理。有一位新客人剛送出詢問，請搜尋網路上關於此人的公開資訊，協助業務了解對方背景。

【客人資料】
姓名：${name}
Email：${email || '未提供'}
國籍：${nationality || '未知'}
FB連結：${fbLink || '未提供'}
旅遊偏好：${interests || '未提供'}
特殊說明：${special ? special.substring(0, 400) : '無'}

【搜尋重點】
- 搜尋此人的 LinkedIn、Facebook、Instagram 公開頁面
- 搜尋此人的旅遊相關文章、部落格或評論
- 了解職業背景（有助判斷預算期待與服務層級）

【請用繁體中文，按以下格式輸出】
▍旅遊風格：（一句話概述）
▍個人興趣：（條列）
▍社群媒體發現：（有找到就描述，沒找到就填「查無公開資訊」）
▍業務建議：（1-2句，幫助業務設計提案方向或開場白）`;

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':        CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':   'web-search-2025-03-05',
      'Content-Type':     'application/json'
    },
    payload: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [{
        type:     'web_search_20250305',
        name:     'web_search',
        max_uses: 5
      }],
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('Claude API 錯誤：' + res.getContentText());
    return '（API 呼叫失敗，請查看 Apps Script 日誌）';
  }

  const result = JSON.parse(res.getContentText());
  let text = '';
  if (result.content) {
    result.content.forEach(block => {
      if (block.type === 'text') text += block.text;
    });
  }

  return text.trim() || '（查無公開資訊）';
}

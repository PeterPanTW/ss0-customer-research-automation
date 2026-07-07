// ============================================================
// 客人背景自動調查 - Google Apps Script
// 流程：每 2 小時輪詢 Smartsheet → 找 2C 空白新進單
//       → Claude 網路搜尋 → 寫回 FB account link 欄
// ============================================================

// ===== 1. 填入你的設定 =====
const CONFIG = {
  ANTHROPIC_API_KEY: 'YOUR_ANTHROPIC_API_KEY',  // → console.anthropic.com 取得
  SMARTSHEET_TOKEN:  'YOUR_SMARTSHEET_TOKEN',   // → Smartsheet 右上角頭像 > Personal Access Tokens
  SHEET_ID:          '3025765638924164',         // 已填入
  RESEARCH_COLUMN_ID: '3711617893459844',        // FB account link 欄位（AI 結果寫入此欄）
  POLL_HOURS:        2.5,                        // 每次輪詢往回看幾小時（比觸發間隔多 0.5 小時作緩衝）
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
// 初始設定說明
// ✅ 欄位 ID、SHEET_ID、RESEARCH_COLUMN_ID 已填入
// 🔲 Step 1：填入 ANTHROPIC_API_KEY 和 SMARTSHEET_TOKEN
// 🔲 Step 2：執行 createTimeTrigger() 建立 2 小時觸發器
// 🔲 Step 3：執行 testWithRow() 確認一切正常
// ============================================================

// ============================================================
// 觸發器管理
// ============================================================

// Step 2：建立每 2 小時自動執行的觸發器（只需執行一次）
function createTimeTrigger() {
  // 先清除舊的同名觸發器，避免重複
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkNewRows') {
      ScriptApp.deleteTrigger(t);
      Logger.log('已清除舊觸發器');
    }
  });

  // 建立新的每 2 小時觸發器
  ScriptApp.newTrigger('checkNewRows')
    .timeBased()
    .everyHours(2)
    .create();

  Logger.log('✅ 觸發器建立完成：每 2 小時執行 checkNewRows()');
}

// 列出目前所有觸發器
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('目前無觸發器，請執行 createTimeTrigger()');
    return;
  }
  triggers.forEach(t => {
    Logger.log(`函式：${t.getHandlerFunction()} | 類型：${t.getEventType()}`);
  });
}

// 手動刪除所有觸發器
function deleteAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('所有觸發器已刪除');
}

// ============================================================
// 主要輪詢函式（每 2 小時自動執行）
// ============================================================

function checkNewRows() {
  Logger.log(`=== 開始輪詢 ${new Date().toLocaleString('zh-TW')} ===`);

  // 取最近 100 筆（Smartsheet 預設按 rowNumber 排序）
  const url = `https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}?pageSize=100&page=1`;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}` },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('❌ 取得 Sheet 失敗：' + res.getContentText());
    return;
  }

  const sheet = JSON.parse(res.getContentText());

  // 只看 POLL_HOURS 小時內的新進單
  const cutoff = new Date(Date.now() - CONFIG.POLL_HOURS * 60 * 60 * 1000);
  let processed = 0;
  let skipped   = 0;

  for (const row of sheet.rows) {
    const created  = row.createdAt ? new Date(row.createdAt) : null;
    if (!created || created < cutoff) continue; // 超過時間窗口，跳過

    const identity = getCellValue(row, '詢問者身分');
    const fbLink   = getCellValue(row, 'FB account link');
    const name     = getCellValue(row, '客人名稱');

    if (!identity.startsWith('2C')) { skipped++; continue; }  // 跳過同業
    if (fbLink)                      { skipped++; continue; }  // 已有內容，跳過

    Logger.log(`▶ 處理：${name} (進單：${created.toISOString()})`);
    processNewRow(row.id);
    processed++;

    Utilities.sleep(1500); // 每筆間隔，避免 API 頻率限制
  }

  Logger.log(`=== 輪詢完成：處理 ${processed} 筆，跳過 ${skipped} 筆 ===`);
}

// 補跑歷史空白資料（手動執行一次，處理所有 2C 空白筆）
function backfillEmptyRows() {
  Logger.log('=== 開始補跑歷史空白資料 ===');

  const url = `https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}?pageSize=500&page=1`;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}` },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('❌ 取得 Sheet 失敗');
    return;
  }

  const sheet = JSON.parse(res.getContentText());
  let processed = 0;

  for (const row of sheet.rows) {
    const identity = getCellValue(row, '詢問者身分');
    const fbLink   = getCellValue(row, 'FB account link');
    const name     = getCellValue(row, '客人名稱');

    if (!identity.startsWith('2C')) continue;
    if (fbLink) continue; // 已有內容

    Logger.log(`▶ 補跑：${name}`);
    processNewRow(row.id);
    processed++;
    Utilities.sleep(2000);
  }

  Logger.log(`=== 補跑完成：共處理 ${processed} 筆 ===`);
}

// ============================================================
// 核心處理邏輯
// ============================================================

function processNewRow(rowId) {
  const row = getRow(rowId);
  if (!row) { Logger.log('Row not found: ' + rowId); return; }

  const identity = getCellValue(row, '詢問者身分');
  if (identity && !identity.startsWith('2C')) {
    Logger.log(`跳過同業詢問 (${identity})`);
    return;
  }

  const name     = getCellValue(row, '客人名稱');
  if (!name) { Logger.log('無客人名稱，跳過'); return; }

  const email       = getCellValue(row, 'Email address');
  const nationality = getCellValue(row, 'Nationality');
  const fbLink      = getCellValue(row, 'FB account link');
  const special     = getCellValue(row, '[Special need and care]');
  const interests   = getCellValue(row, 'When you travel, what are the most important eleme');

  Logger.log(`  Claude 搜尋中：${name} (${email})`);
  const summary = researchWithClaude(name, email, nationality, fbLink, special, interests);
  writeToSmartsheet(rowId, summary);
  Logger.log(`  ✅ 完成：${name}`);
}

// Step 3：手動測試（填入任一 Row ID 執行）
function testWithRow() {
  const testRowId = '2063130630487940'; // 替換為你想測試的 Row ID
  processNewRow(testRowId);
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
  UrlFetchApp.fetch(`https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}/rows`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}`,
      'Content-Type':  'application/json'
    },
    payload: JSON.stringify([{
      id:    rowId,
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
      'x-api-key':         CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'web-search-2025-03-05',
      'Content-Type':      'application/json'
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

// ============================================================
// 輔助：取得所有欄位 ID（需要時可重新執行）
// ============================================================

function getColumnIds() {
  const url = `https://api.smartsheet.com/2.0/sheets/${CONFIG.SHEET_ID}/columns`;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': `Bearer ${CONFIG.SMARTSHEET_TOKEN}` }
  });
  const cols = JSON.parse(res.getContentText()).data;
  cols.forEach(c => Logger.log(`'${c.title}': '${c.id}',`));
}

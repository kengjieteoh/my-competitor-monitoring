// ─── Klook Competitor Monitor — Google Sheets Proxy ──────────────────────────
// HOW TO DEPLOY:
// 1. Go to script.google.com → New project → paste this entire file
// 2. Click Deploy → New deployment → Type: Web app
// 3. Execute as: Me · Who has access: Anyone
// 4. Deploy → copy the Web App URL
// 5. Add it as SHEETS_WEBAPP_URL in GitHub Actions secrets

const SPREADSHEET_ID = "1QRAF6XJex12bue1cZMA3PXV_2zJN81whtGyLk4iWoDs";

const HEADERS = [
  "Date Scraped",
  "Week",
  "Competitor",
  "Category",
  "Campaign Name",
  "Type",
  "Date Start",
  "Date End",
  "Mechanics",
  "Voucher Mechanics",
  "Products Focus",
  "Campaign URL",
  "Full Promo",
  "Verified",
];

const COMP_COLORS = {
  "Traveloka": "#E3F2FD",  // light blue
  "Trip.com":  "#E8F5E9",  // light green
  "KKday":     "#FFF3E0",  // light orange
};

function getOrCreateTab(ss, tabName) {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);

    // Header row styling
    const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
    headerRange.setValues([HEADERS]);
    headerRange.setBackground("#1a1a1a");
    headerRange.setFontColor("#ffffff");
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(11);
    sheet.setFrozenRows(1);

    // Column widths
    const widths = [110, 140, 100, 110, 200, 100, 100, 100, 280, 250, 160, 300, 300, 80];
    for (let i = 0; i < widths.length; i++) {
      sheet.setColumnWidth(i + 1, widths[i]);
    }

    // Wrap text for mechanics columns
    sheet.getRange(1, 9, 1000, 2).setWrap(true);
  }
  return sheet;
}

function applyRowColour(sheet, rowIndex, competitor) {
  const bg = COMP_COLORS[competitor] || "#FFFFFF";
  sheet.getRange(rowIndex, 1, 1, HEADERS.length).setBackground(bg);
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);

    if (payload.action === "append_rows") {
      const sheet = getOrCreateTab(ss, payload.tab);
      for (const row of payload.rows) {
        sheet.appendRow(row);
        const lastRow = sheet.getLastRow();
        applyRowColour(sheet, lastRow, row[2]); // col C = Competitor
      }
      return ok({ rowsAdded: payload.rows.length, tab: payload.tab });
    }

    if (payload.action === "read_month") {
      const sheet = ss.getSheetByName(payload.tab);
      if (!sheet) return ok({ rows: [], message: "Tab not found" });
      const data = sheet.getDataRange().getValues();
      return ok({ rows: data });
    }

    return err("Unknown action: " + payload.action);
  } catch (ex) {
    return err(ex.message);
  }
}

function doGet(e) {
  // Health check
  return ok({ status: "Sheets proxy running", spreadsheet: SPREADSHEET_ID });
}

function ok(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, ...data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function err(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

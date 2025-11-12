const { google } = require('googleapis');
const fs = require('fs').promises;

// Google Sheets Configuration
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Sheet1'; // Change if your sheet has different name

// Google Service Account credentials from environment
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

// Initialize Google Sheets API
async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// Get all existing data from sheet
async function getAllSheetData(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:H`, // Assuming headers in row 1
    });
    return response.data.values || [];
  } catch (error) {
    console.error('❌ Error reading sheet:', error.message);
    return [];
  }
}

// Find row index for a company (by company name + funding round + date)
function findCompanyRow(sheetData, company) {
  return sheetData.findIndex(row => 
    row[0]?.toLowerCase() === company.company.toLowerCase() &&
    row[2] === company.funding_round &&
    row[3] === company.funding_news_date
  );
}

// Format company data as row
function formatCompanyRow(company) {
  return [
    company.company,
    company.website || '',
    company.funding_round || '',
    company.funding_news_date || '',
    company.amount || '',
    company.investor_name || '',
    company.source || '',
    company.last_updated || ''
  ];
}

// Add new rows to sheet
async function addNewRows(sheets, newEntries) {
  if (newEntries.length === 0) {
    console.log('   No new rows to add');
    return;
  }

  const rows = newEntries.map(formatCompanyRow);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: rows
      }
    });
    console.log(`   ✅ Added ${newEntries.length} new rows`);
  } catch (error) {
    console.error('   ❌ Error adding rows:', error.message);
  }
}

// Update existing rows
async function updateRows(sheets, sheetData, updatedEntries) {
  if (updatedEntries.length === 0) {
    console.log('   No rows to update');
    return;
  }

  let updatedCount = 0;

  for (const company of updatedEntries) {
    const rowIndex = findCompanyRow(sheetData, company);
    
    if (rowIndex !== -1) {
      const rowNumber = rowIndex + 2; // +2 because: array is 0-indexed, row 1 is headers
      const range = `${SHEET_NAME}!A${rowNumber}:H${rowNumber}`;

      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: range,
          valueInputOption: 'RAW',
          resource: {
            values: [formatCompanyRow(company)]
          }
        });
        updatedCount++;
        console.log(`   🔄 Updated: ${company.company} - ${company.funding_round}`);
      } catch (error) {
        console.error(`   ❌ Error updating ${company.company}:`, error.message);
      }
    }
  }

  console.log(`   ✅ Updated ${updatedCount} rows`);
}

// Main sync function
async function syncToSheets() {
  try {
    console.log('📊 Starting Google Sheets sync...\n');

    // Load sync data
    const syncData = JSON.parse(await fs.readFile('sync-data.json', 'utf8'));
    const { newEntries, updatedEntries } = syncData;

    console.log(`   New entries to add: ${newEntries.length}`);
    console.log(`   Existing entries to update: ${updatedEntries.length}\n`);

    if (newEntries.length === 0 && updatedEntries.length === 0) {
      console.log('✅ No changes to sync');
      return;
    }

    // Initialize Sheets API
    const sheets = await getSheets();

    // Get existing sheet data
    console.log('📖 Reading current sheet data...');
    const sheetData = await getAllSheetData(sheets);
    console.log(`   Found ${sheetData.length} existing rows\n`);

    // Add new rows
    console.log('➕ Adding new entries...');
    await addNewRows(sheets, newEntries);
    console.log('');

    // Update existing rows
    console.log('🔄 Updating existing entries...');
    await updateRows(sheets, sheetData, updatedEntries);
    console.log('');

    console.log('✅ Google Sheets sync complete!');

  } catch (error) {
    console.error('❌ Sync error:', error.message);
    process.exit(1);
  }
}

syncToSheets();

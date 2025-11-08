require('dotenv').config();
const FundingScraper = require('./scraper');

// Main execution function
async function main() {
  try {
    // Get credentials from environment variables
    const googleServiceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const spreadsheetId = process.env.SPREADSHEET_ID;

    if (!googleServiceAccountKey) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is missing');
    }

    if (!spreadsheetId) {
      throw new Error('SPREADSHEET_ID environment variable is missing');
    }

    console.log('Initializing Funding Scraper...');
    console.log(`Spreadsheet ID: ${spreadsheetId}`);

    // Create scraper instance
    const scraper = new FundingScraper(googleServiceAccountKey, spreadsheetId);

    // Run the scraper
    const result = await scraper.run();

    console.log('\n=== SCRAPER COMPLETED ===');
    console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`New entries added: ${result.entriesAdded}`);
    
    process.exit(0);

  } catch (error) {
    console.error('FATAL ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the main function
main();

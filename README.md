# FundTrackr - Automated Startup Funding Tracker

Automated system to track Indian startup funding announcements from multiple RSS feeds, extract data using AI, deduplicate, and sync to Google Sheets.

## Features

✅ **Multi-source RSS scraping** (YourStory, Inc42, Entrackr, TechCrunch India)  
✅ **AI-powered extraction** (Company, Website, Funding Round, Amount, Investors)  
✅ **Smart deduplication** (Handles multiple rounds, updates, and sources)  
✅ **Source prioritization** (Prefers trusted sources, merges missing data)  
✅ **1-month history** (Stores 30 days of data in GitHub)  
✅ **Google Sheets integration** (Auto-add new rows, update existing)  
✅ **100% cloud-based** (No local install needed)

---

## Setup Instructions

### 1. Get Gemini API Key (Free)

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click **"Get API Key"** → **"Create API Key"**
3. Copy the key

### 2. Setup Google Sheets API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable **Google Sheets API**
4. Create **Service Account**:
   - Go to **IAM & Admin** → **Service Accounts**
   - Click **Create Service Account**
   - Name it (e.g., "fundtrackr-bot")
   - Click **Create and Continue**
   - Skip optional steps, click **Done**
5. Create JSON key:
   - Click on the service account
   - Go to **Keys** tab
   - Click **Add Key** → **Create New Key** → **JSON**
   - Download the JSON file
6. **Share your Google Sheet** with the service account email (found in the JSON file, looks like `fundtrackr-bot@project-id.iam.gserviceaccount.com`)
   - Open your Google Sheet
   - Click **Share**
   - Paste the service account email
   - Give **Editor** permission

### 3. Setup Sheet Headers

In your Google Sheet, add these headers in Row 1:

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| Company | Website | Funding Round | Funding News Date | Amount | Investor Name | Source | Last Updated |

### 4. Add GitHub Secrets

Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these 3 secrets:

1. **`GEMINI_API_KEY`**  
   Value: Your Gemini API key from step 1

2. **`GOOGLE_SHEET_ID`**  
   Value: Your Google Sheet ID (from the URL: `https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit`)

3. **`GOOGLE_SERVICE_ACCOUNT_KEY`**  
   Value: Entire contents of the JSON file from step 2 (copy-paste the whole file content)

### 5. Initialize History File

1. Create a new file in your repo: `history.json`
2. Paste this content:
{
"companies": [],
"last_cleanup": ""
}
3. Commit to main branch

### 6. Run Workflow

1. Go to **Actions** tab in your GitHub repo
2. Click **Funding Scraper** workflow
3. Click **Run workflow** → **Run workflow**
4. Wait for completion (check logs)

---

## How It Works

1. **Scrapes RSS feeds** from 4 Indian startup news sources
2. **Filters articles** from last 7 days
3. **AI extracts** funding data (company, website, round, amount, investors)
4. **Deduplicates** against 30-day history stored in `history.json`:
   - Same company + round + date = Update if better source
   - New round for same company = Add new entry
5. **Syncs to Google Sheets**:
   - New entries → Add rows
   - Updated entries → Edit existing rows
6. **Cleans history** (removes entries older than 30 days)
7. **Commits updated** `history.json` back to repo

---

## Deduplication Logic

- **Unique Key:** `Company Name` + `Funding Round` + `Funding News Date`
- **Multiple sources for same event:** Keeps best source, merges missing data
- **Multiple rounds for same company:** Each round is a separate entry
- **Late announcements:** Updates existing row, doesn't duplicate

---

## Source Priority

1. TechCrunch (Priority: 5)
2. YourStory (Priority: 4)
3. Inc42 (Priority: 4)
4. Entrackr (Priority: 3)
5. Others (Priority: 1)

---

## Schedule

Runs automatically **every day at 9 AM IST** via GitHub Actions.

Manual trigger: Go to **Actions** → **Funding Scraper** → **Run workflow**

---

## Troubleshooting

**No data extracted:**
- Check if RSS feeds are accessible
- Verify Gemini API key is valid
- Check workflow logs for errors

**Google Sheets not updating:**
- Verify service account has Editor access to the sheet
- Check `GOOGLE_SHEET_ID` secret is correct
- Ensure `GOOGLE_SERVICE_ACCOUNT_KEY` is the full JSON content

**Rate limits:**
- Gemini free tier: 60 requests/minute
- Script has 1-second delay between API calls

---

## Files Structure
FundTrackr/
├── .github/
│ └── workflows/
│ └── funding-scraper.yml # GitHub Actions workflow
├── scraper.js # Main scraper + AI extraction
├── sheets-sync.js # Google Sheets sync
├── package.json # Dependencies
├── history.json # 30-day deduplication history
└── README.md # This file


---

## License

MIT License - Free to use and modify

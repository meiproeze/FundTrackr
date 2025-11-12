const axios = require('axios');
const Parser = require('rss-parser');
const { parseISO, isAfter, subDays, format } = require('date-fns');
const fs = require('fs').promises;

// RSS Feeds to scrape
const RSS_FEEDS = [
  'https://yourstory.com/feed',
  'https://inc42.com/feed/',
  'https://entrackr.com/feed/',
  'https://techcrunch.com/tag/india/feed/'
];

// AI API Configuration (using free Gemini API)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

// Source priority (higher = more trusted)
const SOURCE_PRIORITY = {
  'techcrunch.com': 5,
  'yourstory.com': 4,
  'inc42.com': 4,
  'entrackr.com': 3,
  'default': 1
};

// Main scraper function
async function scrapeRSSFeeds() {
  const parser = new Parser();
  const allArticles = [];

  console.log('🔍 Starting RSS feed scraping...');

  for (const feedUrl of RSS_FEEDS) {
    try {
      console.log(`📡 Fetching: ${feedUrl}`);
      const feed = await parser.parseURL(feedUrl);
      
      for (const item of feed.items) {
        // Only process articles from last 7 days
        const articleDate = parseISO(item.isoDate || item.pubDate);
        const sevenDaysAgo = subDays(new Date(), 7);
        
        if (isAfter(articleDate, sevenDaysAgo)) {
          allArticles.push({
            title: item.title,
            link: item.link,
            content: item.contentSnippet || item.content || '',
            pubDate: format(articleDate, 'yyyy-MM-dd'),
            source: new URL(item.link).hostname
          });
        }
      }
    } catch (error) {
      console.error(`❌ Error fetching ${feedUrl}:`, error.message);
    }
  }

  console.log(`✅ Scraped ${allArticles.length} recent articles`);
  return allArticles;
}

// AI Extraction using Gemini
async function extractFundingData(article) {
  const prompt = `Analyze this Indian startup funding news article and extract the following information in JSON format:

Article Title: ${article.title}
Content: ${article.content}

Extract:
- company: Company name (string)
- website: Company website URL (string, extract from content or infer)
- funding_round: Funding round type (Seed, Pre-Seed, Series A, Series B, Bridge, etc.)
- funding_news_date: Date of funding announcement (YYYY-MM-DD format)
- amount: Funding amount with currency (e.g., "₹10 crore", "$2M")
- investor_name: All investor names separated by commas (e.g., "Sequoia Capital, Accel Partners")

IMPORTANT RULES:
- Only extract if this is clearly about a NEW funding round announcement
- If multiple investors, list all separated by commas
- Return null for any field if not found
- If this is NOT a funding announcement, return: {"is_funding": false}

Return ONLY valid JSON, no other text.`;

  try {
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: prompt }]
        }]
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    // Clean markdown code blocks if present
    const jsonText = text.replace(/``````/g, '').trim();
    const extracted = JSON.parse(jsonText);

    if (extracted.is_funding === false) {
      return null;
    }

    return {
      company: extracted.company,
      website: extracted.website,
      funding_round: extracted.funding_round,
      funding_news_date: extracted.funding_news_date || article.pubDate,
      amount: extracted.amount,
      investor_name: extracted.investor_name,
      source: article.source,
      source_link: article.link,
      last_updated: format(new Date(), 'yyyy-MM-dd')
    };
  } catch (error) {
    console.error('❌ AI extraction error:', error.message);
    return null;
  }
}

// Load history from file
async function loadHistory() {
  try {
    const data = await fs.readFile('history.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { companies: [], last_cleanup: '' };
  }
}

// Save history to file
async function saveHistory(history) {
  await fs.writeFile('history.json', JSON.stringify(history, null, 2));
}

// Clean old entries (older than 30 days)
function cleanOldEntries(companies) {
  const thirtyDaysAgo = subDays(new Date(), 30);
  return companies.filter(company => {
    const companyDate = parseISO(company.funding_news_date);
    return isAfter(companyDate, thirtyDaysAgo);
  });
}

// Deduplicate and merge data
function deduplicateAndMerge(existingCompanies, newData) {
  const updated = [...existingCompanies];
  const newEntries = [];

  for (const newItem of newData) {
    if (!newItem) continue;

    // Find existing entry with same company + round + date
    const existingIndex = updated.findIndex(existing => 
      existing.company.toLowerCase() === newItem.company.toLowerCase() &&
      existing.funding_round === newItem.funding_round &&
      existing.funding_news_date === newItem.funding_news_date
    );

    if (existingIndex !== -1) {
      // Entry exists - check if we should update
      const existing = updated[existingIndex];
      const existingPriority = SOURCE_PRIORITY[existing.source] || SOURCE_PRIORITY.default;
      const newPriority = SOURCE_PRIORITY[newItem.source] || SOURCE_PRIORITY.default;

      if (newPriority >= existingPriority) {
        // Merge data - prefer new source but fill missing fields from existing
        updated[existingIndex] = {
          ...existing,
          ...newItem,
          website: newItem.website || existing.website,
          amount: newItem.amount || existing.amount,
          investor_name: newItem.investor_name || existing.investor_name,
          last_updated: format(new Date(), 'yyyy-MM-dd')
        };
        console.log(`🔄 Updated: ${newItem.company} - ${newItem.funding_round}`);
      }
    } else {
      // New entry
      newEntries.push(newItem);
      console.log(`✨ New: ${newItem.company} - ${newItem.funding_round}`);
    }
  }

  return {
    allCompanies: [...updated, ...newEntries],
    newEntries: newEntries,
    updatedEntries: updated.filter((item, index) => {
      const original = existingCompanies[index];
      return original && item.last_updated !== original.last_updated;
    })
  };
}

// Main execution
async function main() {
  try {
    console.log('🚀 FundTrackr - Starting...\n');

    // Step 1: Load history
    console.log('📂 Loading history...');
    const history = await loadHistory();
    console.log(`   Found ${history.companies.length} existing entries\n`);

    // Step 2: Scrape RSS feeds
    const articles = await scrapeRSSFeeds();
    console.log('');

    // Step 3: Extract funding data with AI
    console.log('🤖 Extracting funding data with AI...');
    const extractedData = [];
    for (const article of articles) {
      const data = await extractFundingData(article);
      if (data) {
        extractedData.push(data);
      }
      // Rate limit: wait 1 second between API calls
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`   Extracted ${extractedData.length} funding announcements\n`);

    // Step 4: Deduplicate and merge
    console.log('🔍 Deduplicating and merging...');
    const { allCompanies, newEntries, updatedEntries } = deduplicateAndMerge(
      history.companies,
      extractedData
    );
    console.log('');

    // Step 5: Clean old entries
    console.log('🧹 Cleaning old entries (>30 days)...');
    const cleanedCompanies = cleanOldEntries(allCompanies);
    const removed = allCompanies.length - cleanedCompanies.length;
    console.log(`   Removed ${removed} old entries\n`);

    // Step 6: Save history
    await saveHistory({
      companies: cleanedCompanies,
      last_cleanup: format(new Date(), 'yyyy-MM-dd HH:mm:ss')
    });

    // Step 7: Save results for Google Sheets sync
    await fs.writeFile('sync-data.json', JSON.stringify({
      newEntries,
      updatedEntries
    }, null, 2));

    console.log('✅ Scraping complete!');
    console.log(`   Total companies in history: ${cleanedCompanies.length}`);
    console.log(`   New entries: ${newEntries.length}`);
    console.log(`   Updated entries: ${updatedEntries.length}`);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();

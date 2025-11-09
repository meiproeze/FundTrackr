const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs').promises;

// Configuration
const RSS_FEEDS = [
  'https://techcrunch.com/tag/funding/feed/',
  'https://www.crunchbase.com/feed',
  'https://yourstory.com/feed',
  // Add more RSS feeds here
];

const SOURCE_PRIORITY = {
  'techcrunch.com': 1,
  'crunchbase.com': 2,
  'yourstory.com': 3,
  'inc42.com': 4,
  'venturebeat.com': 5,
};

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

// Load history file
async function loadHistory() {
  try {
    const data = await fs.readFile('history.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { entries: [] };
  }
}

// Save history file
async function saveHistory(history) {
  await fs.writeFile('history.json', JSON.stringify(history, null, 2));
}

// Clean old entries (older than 30 days)
function cleanOldEntries(entries) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  return entries.filter(entry => {
    const entryDate = new Date(entry.funding_news_date);
    return entryDate >= thirtyDaysAgo;
  });
}

// Fetch RSS feeds
async function fetchRSSFeeds() {
  const allArticles = [];
  
  for (const feed of RSS_FEEDS) {
    try {
      const response = await axios.get(feed);
      const articles = parseRSS(response.data, feed);
      allArticles.push(...articles);
    } catch (error) {
      console.error(`Error fetching ${feed}:`, error.message);
    }
  }
  
  return allArticles;
}

// Parse RSS XML (simplified - you may want to use xml2js library)
function parseRSS(xml, feedUrl) {
  const articles = [];
  const itemRegex = /<item>(.*?)<\/item>/gs;
  const matches = xml.matchAll(itemRegex);
  
  for (const match of matches) {
    const item = match[1];
    const title = item.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
    const description = item.match(/<description>(.*?)<\/description>/)?.[1] || '';
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    
    articles.push({
      title,
      link,
      description: description.replace(/<[^>]*>/g, ''), // Remove HTML tags
      pubDate: new Date(pubDate).toISOString().split('T')[0],
      source: new URL(feedUrl).hostname,
    });
  }
  
  return articles;
}

// Extract funding data using Gemini AI
async function extractFundingData(article) {
  const prompt = `
Analyze this funding news article and extract the following information in JSON format:

Article Title: ${article.title}
Description: ${article.description}
Source: ${article.source}

Please extract:
1. company_name: The name of the company that received funding
2. website: The company's website URL (if mentioned)
3. funding_round: The type of funding round (Seed, Series A, Series B, etc.)
4. funding_amount: The amount of funding (with currency symbol)
5. investor_names: List of investor names (individuals or companies), separated by commas
6. industry: The industry/sector of the company
7. description: A brief one-line description of what the company does
8. funding_date: The date when the funding was announced (YYYY-MM-DD format)

If any information is not available in the article, use "Unknown" or leave blank.

Return ONLY valid JSON, no other text.
`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const extracted = JSON.parse(jsonMatch[0]);
      
      return {
        company: extracted.company_name || 'Unknown',
        website: extracted.website || '',
        funding_round: extracted.funding_round || 'Unknown',
        funding_news_date: extracted.funding_date || article.pubDate,
        amount: extracted.funding_amount || 'Undisclosed',
        investor_name: extracted.investor_names || '',
        industry: extracted.industry || 'AI/ML',
        description: extracted.description || article.description.substring(0, 100),
        source: article.link,
        last_updated: new Date().toISOString().split('T')[0],
      };
    }
  } catch (error) {
    console.error('AI extraction error:', error.message);
  }
  
  return null;
}

// Check if entry is duplicate
function isDuplicate(entry, history) {
  return history.entries.some(existing => 
    existing.company.toLowerCase() === entry.company.toLowerCase() &&
    existing.funding_round === entry.funding_round &&
    existing.funding_news_date === entry.funding_news_date
  );
}

// Merge data from multiple sources
function mergeEntries(existing, newEntry) {
  const existingPriority = SOURCE_PRIORITY[new URL(existing.source).hostname] || 999;
  const newPriority = SOURCE_PRIORITY[new URL(newEntry.source).hostname] || 999;
  
  // Prefer source with higher priority (lower number)
  const preferred = newPriority < existingPriority ? newEntry : existing;
  const secondary = newPriority < existingPriority ? existing : newEntry;
  
  // Merge missing fields
  return {
    ...preferred,
    website: preferred.website || secondary.website,
    amount: preferred.amount !== 'Undisclosed' ? preferred.amount : secondary.amount,
    investor_name: preferred.investor_name || secondary.investor_name,
    last_updated: new Date().toISOString().split('T')[0],
  };
}

// Update Google Sheets
async function updateGoogleSheets(entries) {
  const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  
  // Read existing data
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Funding_Data!A:K',
  });
  
  const existingRows = response.data.values || [];
  const headerRow = existingRows[0];
  
  for (const entry of entries) {
    // Check if company+round+date exists
    const existingIndex = existingRows.findIndex((row, idx) => 
      idx > 0 && // Skip header
      row[0] === entry.company &&
      row[4] === entry.funding_round &&
      row[9] === entry.funding_news_date
    );
    
    const rowData = [
      entry.company,
      entry.website,
      '', // LinkedIn URL - leave empty for now
      entry.amount,
      entry.funding_round,
      entry.industry,
      entry.description,
      entry.source,
      entry.investor_name,
      entry.funding_news_date,
      entry.last_updated,
    ];
    
    if (existingIndex >= 0) {
      // Update existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Funding_Data!A${existingIndex + 1}:K${existingIndex + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [rowData] },
      });
      console.log(`Updated: ${entry.company} - ${entry.funding_round}`);
    } else {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Funding_Data!A:K',
        valueInputOption: 'RAW',
        resource: { values: [rowData] },
      });
      console.log(`Added: ${entry.company} - ${entry.funding_round}`);
    }
  }
}

// Main execution
async function main() {
  console.log('Starting funding data scraper...');
  
  // Load history
  let history = await loadHistory();
  console.log(`Loaded ${history.entries.length} historical entries`);
  
  // Clean old entries
  history.entries = cleanOldEntries(history.entries);
  console.log(`After cleanup: ${history.entries.length} entries`);
  
  // Fetch RSS feeds
  const articles = await fetchRSSFeeds();
  console.log(`Fetched ${articles.length} articles from RSS feeds`);
  
  // Process articles
  const newEntries = [];
  
  for (const article of articles) {
    const extracted = await extractFundingData(article);
    
    if (extracted && extracted.company !== 'Unknown') {
      if (isDuplicate(extracted, history)) {
        // Check if we need to merge/update data
        const existingIndex = history.entries.findIndex(e =>
          e.company.toLowerCase() === extracted.company.toLowerCase() &&
          e.funding_round === extracted.funding_round &&
          e.funding_news_date === extracted.funding_news_date
        );
        
        if (existingIndex >= 0) {
          history.entries[existingIndex] = mergeEntries(
            history.entries[existingIndex],
            extracted
          );
        }
      } else {
        // New entry
        history.entries.push(extracted);
        newEntries.push(extracted);
      }
    }
    
    // Rate limiting for AI API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log(`Found ${newEntries.length} new entries`);
  
  // Update Google Sheets
  if (newEntries.length > 0) {
    await updateGoogleSheets(newEntries);
  }
  
  // Save updated history
  await saveHistory(history);
  console.log('Scraper completed successfully!');
}

main().catch(console.error);

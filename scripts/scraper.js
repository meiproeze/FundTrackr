const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs').promises;

// RSS Feed Sources
const RSS_FEEDS = [
  'https://techcrunch.com/tag/funding/feed/',
  'https://www.crunchbase.com/feed',
  'https://yourstory.com/feed',
  'https://inc42.com/feed/',
];

// Source Priority (lower = more trusted)
const SOURCE_PRIORITY = {
  'techcrunch.com': 1,
  'crunchbase.com': 2,
  'yourstory.com': 3,
  'inc42.com': 4,
  'venturebeat.com': 5,
};

// Initialize AI APIs
let genAI, geminiModel;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-pro' });
}

// Multi-API Extraction with Fallback
async function extractWithAI(article) {
  const prompt = `
Analyze this funding news and extract as JSON:

Title: ${article.title}
Description: ${article.description}
Source: ${article.source}

Extract:
1. company_name
2. website
3. funding_round (Seed/Series A/B/C/etc)
4. funding_amount (with currency)
5. investor_names (comma-separated list of investors - companies or individuals)
6. industry
7. description (one-line company description)
8. funding_date (YYYY-MM-DD)

Return ONLY valid JSON, no other text.
`;

  // Try Bytez API first
  if (process.env.BYTEZ_API_KEY) {
    try {
      console.log('Trying Bytez API...');
      const response = await axios.post('https://api.bytez.com/v1/chat/completions', {
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.BYTEZ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      
      const text = response.data.choices[0].message.content;
      return parseAIResponse(text, article);
    } catch (error) {
      console.error('Bytez API failed:', error.message);
    }
  }

  // Try OpenRouter API
  if (process.env.OPENROUTER_API_KEY) {
    try {
      console.log('Trying OpenRouter API...');
      const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: 'meta-llama/llama-3.1-8b-instruct:free',
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      
      const text = response.data.choices[0].message.content;
      return parseAIResponse(text, article);
    } catch (error) {
      console.error('OpenRouter API failed:', error.message);
    }
  }

  // Fallback to Gemini
  if (geminiModel) {
    try {
      console.log('Trying Gemini API...');
      const result = await geminiModel.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      return parseAIResponse(text, article);
    } catch (error) {
      console.error('Gemini API failed:', error.message);
    }
  }

  console.error('All AI APIs failed');
  return null;
}

// Parse AI response
function parseAIResponse(text, article) {
  try {
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
        industry: extracted.industry || '',
        description: extracted.description || article.description.substring(0, 150),
        source: article.link,
        last_updated: new Date().toISOString().split('T')[0],
      };
    }
  } catch (error) {
    console.error('JSON parse error:', error.message);
  }
  return null;
}

// Load history (30 days)
async function loadHistory() {
  try {
    const data = await fs.readFile('history.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { entries: [] };
  }
}

// Save history
async function saveHistory(history) {
  await fs.writeFile('history.json', JSON.stringify(history, null, 2));
}

// Clean old entries (30 days)
function cleanOldEntries(entries) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  return entries.filter(entry => {
    const entryDate = new Date(entry.funding_news_date);
    return entryDate >= thirtyDaysAgo;
  });
}

// Fetch RSS
async function fetchRSSFeeds() {
  const allArticles = [];
  
  for (const feed of RSS_FEEDS) {
    try {
      const response = await axios.get(feed, { timeout: 15000 });
      const articles = parseRSS(response.data, feed);
      allArticles.push(...articles);
    } catch (error) {
      console.error(`Error fetching ${feed}:`, error.message);
    }
  }
  
  return allArticles;
}

// Parse RSS
function parseRSS(xml, feedUrl) {
  const articles = [];
  const itemRegex = /<item>(.*?)<\/item>/gs;
  const matches = xml.matchAll(itemRegex);
  
  for (const match of matches) {
    const item = match[1];
    const title = item.match(/<title>(<!\[CDATA\[)?(.*?)(]]>)?<\/title>/)?.[2] || '';
    const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
    const description = item.match(/<description>(<!\[CDATA\[)?(.*?)(]]>)?<\/description>/)?.[2] || '';
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    
    articles.push({
      title,
      link,
      description: description.replace(/<[^>]*>/g, ''),
      pubDate: new Date(pubDate).toISOString().split('T')[0],
      source: new URL(feedUrl).hostname,
    });
  }
  
  return articles;
}

// Check duplicate
function isDuplicate(entry, history) {
  return history.entries.some(existing =>
    existing.company.toLowerCase() === entry.company.toLowerCase() &&
    existing.funding_round === entry.funding_round &&
    existing.funding_news_date === entry.funding_news_date
  );
}

// Merge entries from multiple sources
function mergeEntries(existing, newEntry) {
  const existingPriority = SOURCE_PRIORITY[new URL(existing.source).hostname] || 999;
  const newPriority = SOURCE_PRIORITY[new URL(newEntry.source).hostname] || 999;
  
  const preferred = newPriority < existingPriority ? newEntry : existing;
  const secondary = newPriority < existingPriority ? existing : newEntry;
  
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
  
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Funding_Data!A:K',
  });
  
  const existingRows = response.data.values || [];
  
  for (const entry of entries) {
    const existingIndex = existingRows.findIndex((row, idx) =>
      idx > 0 &&
      row[0] === entry.company &&
      row[4] === entry.funding_round &&
      row[9] === entry.funding_news_date
    );
    
    const rowData = [
      entry.company,
      entry.website,
      '', // LinkedIn
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
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Funding_Data!A${existingIndex + 1}:K${existingIndex + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [rowData] },
      });
      console.log(`Updated: ${entry.company}`);
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Funding_Data!A:K',
        valueInputOption: 'RAW',
        resource: { values: [rowData] },
      });
      console.log(`Added: ${entry.company}`);
    }
  }
}

// Main
async function main() {
  console.log('Starting scraper...');
  
  let history = await loadHistory();
  console.log(`Loaded ${history.entries.length} entries`);
  
  history.entries = cleanOldEntries(history.entries);
  console.log(`After cleanup: ${history.entries.length} entries`);
  
  const articles = await fetchRSSFeeds();
  console.log(`Fetched ${articles.length} articles`);
  
  const newEntries = [];
  
  for (const article of articles) {
    const extracted = await extractWithAI(article);
    
    if (extracted && extracted.company !== 'Unknown') {
      if (isDuplicate(extracted, history)) {
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
        history.entries.push(extracted);
        newEntries.push(extracted);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log(`Found ${newEntries.length} new entries`);
  
  if (newEntries.length > 0) {
    await updateGoogleSheets(newEntries);
  }
  
  await saveHistory(history);
  console.log('Complete!');
}

main().catch(console.error);

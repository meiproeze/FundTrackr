const path = require('path');
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
  // FIXED: Use gemini-1.5-flash-latest (correct model name)
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
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

  // Try Bytez API first - FINAL FIX
  if (process.env.BYTEZ_API_KEY) {
    try {
      console.log('Trying Bytez API...');
      
      // FIXED: Bytez correct endpoint from docs
      const response = await axios.post('https://api.bytez.com/models/v2/openai/v1/chat/completions', {
        model: 'Qwen/Qwen2.5-3B-Instruct', // FREE fast model
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 500
      }, {
        headers: {
          'Authorization': process.env.BYTEZ_API_KEY, // No "Bearer" prefix
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      
      // Parse response
      const text = response.data.choices[0].message.content;
      const result = parseAIResponse(text, article);
      
      if (result) {
        console.log('✅ Bytez API succeeded');
        return result;
      }
    } catch (error) {
      console.error('Bytez API failed:', error.response?.data?.error || error.message);
    }
  }

  // Try OpenRouter API with better free model
  if (process.env.OPENROUTER_API_KEY) {
    try {
      console.log('Trying OpenRouter API...');
      const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: 'qwen/qwen-2.5-7b-instruct:free', // Alternative free model (more stable)
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/fundtracker',
          'X-Title': 'Funding Tracker'
        },
        timeout: 30000
      });
      
      const text = response.data.choices[0].message.content;
      const result = parseAIResponse(text, article);
      
      if (result) {
        console.log('✅ OpenRouter API succeeded');
        return result;
      }
    } catch (error) {
      console.error('OpenRouter API failed:', error.response?.data?.error || error.message);
    }
  }

  // Fallback to Gemini - FIXED MODEL NAME
  if (geminiModel) {
    try {
      console.log('Trying Gemini API...');
      const result = await geminiModel.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      const parsed = parseAIResponse(text, article);
      
      if (parsed) {
        console.log('✅ Gemini API succeeded');
        return parsed;
      }
    } catch (error) {
      console.error('Gemini API failed:', error.message);
    }
  }

  console.error('❌ All AI APIs failed');
  return null;
}

// Parse AI response
function parseAIResponse(text, article) {
  try {
    // Remove markdown code blocks if present
    let cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
    
    // Try to find JSON in the response
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const extracted = JSON.parse(jsonMatch[0]);
      
      // Validate that we got something useful
      if (!extracted.company_name || extracted.company_name === 'Unknown' || extracted.company_name.length < 2) {
        return null;
      }
      
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
    const data = await fs.readFile(path.join(__dirname, 'history.json'), 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('History file not found, starting fresh');
    return { entries: [] };
  }
}

// Save history
async function saveHistory(history) {
  await fs.writeFile(path.join(__dirname, 'history.json'), JSON.stringify(history, null, 2));
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
      console.log(`Fetching: ${feed}`);
      const response = await axios.get(feed, { 
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FundingTracker/1.0)'
        }
      });
      const articles = parseRSS(response.data, feed);
      console.log(`Found ${articles.length} articles from ${feed}`);
      allArticles.push(...articles);
    } catch (error) {
      console.error(`Error fetching ${feed}:`, error.message);
    }
  }
  
  return allArticles;
}

// Parse RSS (improved)
function parseRSS(xml, feedUrl) {
  const articles = [];
  const itemRegex = /<item>(.*?)<\/item>/gs;
  const matches = xml.matchAll(itemRegex);
  
  for (const match of matches) {
    const item = match[1];
    
    // Extract title
    const titleMatch = item.match(/<title>(<!\[CDATA\[)?(.*?)(]]>)?<\/title>/s);
    const title = titleMatch ? titleMatch[2].trim() : '';
    
    // Extract link
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : '';
    
    // Extract description
    const descMatch = item.match(/<description>(<!\[CDATA\[)?(.*?)(]]>)?<\/description>/s);
    let description = descMatch ? descMatch[2] : '';
    description = description.replace(/<[^>]*>/g, '').trim(); // Remove HTML tags
    
    // Extract pubDate
    const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
    let pubDate = new Date().toISOString().split('T')[0]; // Default to today
    if (pubDateMatch) {
      try {
        pubDate = new Date(pubDateMatch[1]).toISOString().split('T')[0];
      } catch (e) {
        console.error('Date parse error:', e.message);
      }
    }
    
    // Only add if we have minimum required fields
    if (title && link) {
      articles.push({
        title,
        link,
        description,
        pubDate,
        source: new URL(feedUrl).hostname,
      });
    }
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
  if (!process.env.SPREADSHEET_ID) {
    console.log('⚠️ SPREADSHEET_ID not set, skipping Google Sheets update');
    return;
  }
  
  try {
    console.log('Connecting to Google Sheets...');
    
    const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;
    
    console.log('Reading existing data...');
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
        '', // LinkedIn (will add later)
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
        console.log(`✅ Updated: ${entry.company}`);
      } else {
        // Append new row
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'Funding_Data!A:K',
          valueInputOption: 'RAW',
          resource: { values: [rowData] },
        });
        console.log(`✅ Added: ${entry.company}`);
      }
      
      // Rate limiting for Google Sheets API
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error('Error updating Google Sheets:', error.message);
    if (error.response?.data) {
      console.error('Details:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// Main
async function main() {
  console.log('🚀 Starting Funding Tracker Scraper...');
  console.log(`📅 Date: ${new Date().toISOString()}`);
  
  try {
    // Load history
    let history = await loadHistory();
    console.log(`📊 Loaded ${history.entries.length} historical entries`);
    
    // Clean old entries
    history.entries = cleanOldEntries(history.entries);
    console.log(`🧹 After cleanup: ${history.entries.length} entries`);
    
    // Fetch RSS feeds
    const articles = await fetchRSSFeeds();
    console.log(`📰 Fetched ${articles.length} total articles`);
    
    // Filter for funding articles
    const fundingKeywords = ['raised', 'funding', 'series', 'seed', 'investment', 'round', 'capital'];
    const fundingArticles = articles.filter(article => {
      const text = (article.title + ' ' + article.description).toLowerCase();
      return fundingKeywords.some(keyword => text.includes(keyword));
    });
    console.log(`💰 Found ${fundingArticles.length} funding articles`);
    
    const newEntries = [];
    let successCount = 0;
    let failCount = 0;
    
    // Process each funding article (limit to first 10 to stay within API limits)
    const articlesToProcess = fundingArticles.slice(0, 10);
    
    for (let i = 0; i < articlesToProcess.length; i++) {
      const article = articlesToProcess[i];
      console.log(`\n[${i + 1}/${articlesToProcess.length}] Processing: ${article.title.substring(0, 60)}...`);
      
      const extracted = await extractWithAI(article);
      
      if (extracted && extracted.company !== 'Unknown') {
        if (isDuplicate(extracted, history)) {
          console.log(`⏭️  Skipped (duplicate): ${extracted.company}`);
          
          // Merge with existing if better source
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
          successCount++;
          console.log(`✅ Extracted: ${extracted.company} - ${extracted.amount}`);
        }
      } else {
        failCount++;
        console.log(`⚠️  Failed to extract data from article`);
      }
      
      // Rate limiting between API calls
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log(`\n📊 Summary:`);
    console.log(`   - Total articles: ${articles.length}`);
    console.log(`   - Funding articles: ${fundingArticles.length}`);
    console.log(`   - Processed: ${articlesToProcess.length}`);
    console.log(`   - Successful extractions: ${successCount}`);
    console.log(`   - Failed extractions: ${failCount}`);
    console.log(`   - New unique entries: ${newEntries.length}`);
    console.log(`   - Total in history: ${history.entries.length}`);
    
    // Update Google Sheets
    if (newEntries.length > 0) {
      console.log(`\n📤 Updating Google Sheets...`);
      await updateGoogleSheets(newEntries);
      console.log(`✅ Google Sheets updated!`);
    } else {
      console.log(`\n⚠️  No new entries to add to Google Sheets`);
    }
    
    // Save history
    await saveHistory(history);
    console.log(`💾 History saved`);
    
    console.log(`\n🎉 Scraper finished successfully!`);
    
  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Run the scraper
main();

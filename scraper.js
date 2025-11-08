const RssParser = require('rss-parser');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

// Initialize Parser with custom fields
const parser = new RssParser({
  requestOptions: {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  },
  customFields: {
    item: [
      ['description', 'description'],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

const sheets = google.sheets('v4');

// Configuration
const FUNDING_KEYWORDS = [
  'raised', 'funding', 'series', 'seed', 'investment', 'invested',
  'round', 'venture capital', 'vc funding', '$', 'million', 'crore',
  'backed', 'announces funding', 'secures funding', 'closes funding'
];

// Source priority ranking (higher = more trusted)
const SOURCE_PRIORITY = {
  'techcrunch': 10,
  'venturebeat': 9,
  'crunchbase': 9,
  'inc42': 8,
  'vccircle': 8,
  'economictimes': 7,
  'yourstory': 7,
  'default': 5
};

const HISTORY_FILE = 'funding_history.json';
const HISTORY_RETENTION_DAYS = 30;

class FundingScraper {
  constructor(apiKey, spreadsheetId, aiApiKey = null) {
    this.apiKey = apiKey;
    this.spreadsheetId = spreadsheetId;
    this.aiApiKey = aiApiKey;
    this.auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(apiKey),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  async initializeSheets() {
    this.auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(this.apiKey),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  // Load funding history from JSON file
  async loadHistory() {
    try {
      const data = await fs.readFile(HISTORY_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.log('No history file found, starting fresh');
      return { lastUpdated: new Date().toISOString(), data: [] };
    }
  }

  // Save funding history to JSON file
  async saveHistory(history) {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
  }

  // Clean old data (older than 30 days)
  cleanOldData(historyData) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - HISTORY_RETENTION_DAYS);
    
    return historyData.filter(item => {
      const itemDate = new Date(item.funding_news_date);
      return itemDate >= cutoffDate;
    });
  }

  // Get source priority score
  getSourcePriority(sourceUrl) {
    const lowerUrl = sourceUrl.toLowerCase();
    for (const [key, priority] of Object.entries(SOURCE_PRIORITY)) {
      if (lowerUrl.includes(key)) {
        return priority;
      }
    }
    return SOURCE_PRIORITY.default;
  }

  // Create unique key for deduplication
  createUniqueKey(companyName, round, date) {
    return `${companyName.toLowerCase().trim()}_${round.toLowerCase().trim()}_${date}`.replace(/\s+/g, '_');
  }

  // Read RSS feed sources from Google Sheet
  async getRSSFeedSources() {
    try {
      const authClient = await this.auth.getClient();
      const response = await sheets.spreadsheets.values.get({
        auth: authClient,
        spreadsheetId: this.spreadsheetId,
        range: 'Sources!A:F',
      });

      const rows = response.data.values || [];
      if (rows.length <= 1) {
        console.log('No RSS sources found in Sources sheet');
        return [];
      }

      // Skip header row
      return rows.slice(1).map((row, index) => ({
        id: row[0] || `source_${index}`,
        name: row[1] || 'Unknown',
        url: row[2] || '',
        type: row[3] || 'RSS',
        status: row[4] || 'active',
        lastChecked: row[5] || ''
      })).filter(source => source.url && source.status.toLowerCase() === 'active');
    } catch (error) {
      console.error('Error reading RSS sources:', error.message);
      return [];
    }
  }

  // Parse RSS feed and extract articles
  async parseFeed(feedUrl) {
    try {
      console.log(`Parsing feed: ${feedUrl}`);
      const feed = await parser.parseURL(feedUrl);
      return feed.items || [];
    } catch (error) {
      console.error(`Error parsing feed ${feedUrl}:`, error.message);
      return [];
    }
  }

  // Check if article contains funding keywords
  isFundingRelated(title, description) {
    const text = `${title} ${description || ''}`.toLowerCase();
    return FUNDING_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  }

  // Extract company name from title
  extractCompanyName(title, content) {
    // Try to find company name pattern
    const patterns = [
      /^([A-Za-z0-9\s\-]+?)\s+(?:raises|secures|announces|closes|gets|bags)/i,
      /^([A-Za-z0-9\s\-]+?)\s+[Ss]eries\s+[A-Z]/i,
      /^([A-Za-z0-9\s\-]+?)\s+\$\d+/i,
    ];

    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return title.substring(0, 50).trim();
  }

  // Extract funding information using regex
  extractFundingInfo(text) {
    const fundingRegex = /\$\s?(\d+(?:\.\d{1,2})?)\s?(M|B|K)?/gi;
    const croreRegex = /₹?\s?(\d+(?:\.\d{1,2})?)\s?crore/gi;
    const roundRegex = /\b(?:seed|pre-seed|series\s+[a-z]|series\s+[a-z]\+|round|angel|bridge)\b/gi;

    const fundingMatches = [...text.matchAll(fundingRegex)];
    const croreMatches = [...text.matchAll(croreRegex)];
    const roundMatches = [...text.matchAll(roundRegex)];

    let fundingAmount = 'Undisclosed';
    if (fundingMatches.length > 0) {
      const match = fundingMatches[fundingMatches.length - 1];
      fundingAmount = `$${match[1]}${match[2] || 'M'}`;
    } else if (croreMatches.length > 0) {
      const match = croreMatches[croreMatches.length - 1];
      fundingAmount = `₹${match[1]} crore`;
    }

    let fundingRound = 'Unknown';
    if (roundMatches.length > 0) {
      fundingRound = roundMatches[0][0].charAt(0).toUpperCase() + roundMatches[0][0].slice(1).toLowerCase();
    }

    return { fundingAmount, fundingRound };
  }

  // Extract investor names
  extractInvestors(text) {
    const investorPatterns = [
      /(?:led by|from|investors included?|backed by|participation from)\s+([A-Z][A-Za-z0-9\s,&]+?)(?:\.|,|and|with)/gi,
      /investors?\s+(?:include|are|like)\s+([A-Z][A-Za-z0-9\s,&]+?)(?:\.|,|and)/gi
    ];

    const investors = new Set();
    for (const pattern of investorPatterns) {
      const matches = [...text.matchAll(pattern)];
      for (const match of matches) {
        if (match[1]) {
          // Split by comma and clean
          const names = match[1].split(/,|\band\b/).map(n => n.trim()).filter(n => n.length > 2 && n.length < 50);
          names.forEach(name => investors.add(name));
        }
      }
    }

    return Array.from(investors).slice(0, 5).join(', ') || 'Unknown';
  }

  // Generate LinkedIn URL from company name
  generateLinkedInUrl(companyName) {
    const slug = companyName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    return `https://linkedin.com/company/${slug}`;
  }

  // Extract industry from content
  extractIndustry(text) {
    const industries = {
      'AI/ML': ['artificial intelligence', 'machine learning', 'ai', 'ml', 'neural', 'deep learning'],
      'FinTech': ['fintech', 'finance', 'banking', 'payment', 'crypto', 'blockchain', 'web3'],
      'HealthTech': ['healthcare', 'health', 'medical', 'biotech', 'pharma', 'wellness', 'telemedicine'],
      'SaaS': ['saas', 'software', 'cloud', 'platform', 'service'],
      'E-commerce': ['ecommerce', 'retail', 'shopping', 'marketplace', 'commerce'],
      'EdTech': ['education', 'edtech', 'learning', 'online course'],
      'ClimTech': ['climate', 'energy', 'sustainability', 'green'],
      'Technology': ['tech', 'technology'],
      'Social': ['social', 'community', 'network'],
    };

    const lowerText = text.toLowerCase();
    for (const [industry, keywords] of Object.entries(industries)) {
      if (keywords.some(kw => lowerText.includes(kw))) {
        return industry;
      }
    }

    return 'Technology';
  }

  // Process and extract funding data from article
  async processFundingArticle(article, sourceLink) {
    try {
      const title = article.title || '';
      const description = article.contentSnippet || article.description || '';
      const pubDate = article.pubDate ? new Date(article.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

      if (!this.isFundingRelated(title, description)) {
        return null;
      }

      const fullText = `${title} ${description}`;
      const companyName = this.extractCompanyName(title, fullText);
      const { fundingAmount, fundingRound } = this.extractFundingInfo(fullText);
      const investors = this.extractInvestors(fullText);
      const industry = this.extractIndustry(fullText);
      const linkedinUrl = this.generateLinkedInUrl(companyName);
      const sourcePriority = this.getSourcePriority(sourceLink);

      return {
        company: companyName.trim(),
        website: '',
        linkedinUrl: linkedinUrl,
        fundingAmount: fundingAmount,
        fundingRound: fundingRound,
        industry: industry,
        description: description.substring(0, 200),
        sourceLink: sourceLink || article.link || '',
        investorName: investors,
        fundingNewsDate: pubDate,
        lastUpdated: new Date().toISOString().split('T')[0],
        sourcePriority: sourcePriority,
        uniqueKey: this.createUniqueKey(companyName, fundingRound, pubDate)
      };
    } catch (error) {
      console.error('Error processing article:', error.message);
      return null;
    }
  }

  // Deduplicate and merge data from history
  async deduplicateWithHistory(newData, history) {
    const historyMap = new Map();
    history.data.forEach(item => {
      historyMap.set(item.uniqueKey, item);
    });

    const toAdd = [];
    const toUpdate = [];

    for (const newItem of newData) {
      const existing = historyMap.get(newItem.uniqueKey);
      
      if (!existing) {
        // New entry
        toAdd.push(newItem);
        historyMap.set(newItem.uniqueKey, newItem);
      } else {
        // Entry exists - check if we should update
        if (newItem.sourcePriority > existing.sourcePriority) {
          // New source is more authoritative
          const merged = { ...existing, ...newItem, lastUpdated: new Date().toISOString().split('T')[0] };
          toUpdate.push(merged);
          historyMap.set(newItem.uniqueKey, merged);
        } else if (newItem.sourcePriority === existing.sourcePriority) {
          // Same priority - merge missing fields
          const merged = { ...existing };
          Object.keys(newItem).forEach(key => {
            if (!merged[key] || merged[key] === '' || merged[key] === 'Unknown' || merged[key] === 'Undisclosed') {
              merged[key] = newItem[key];
            }
          });
          merged.lastUpdated = new Date().toISOString().split('T')[0];
          toUpdate.push(merged);
          historyMap.set(newItem.uniqueKey, merged);
        }
      }
    }

    return { toAdd, toUpdate, updatedHistory: Array.from(historyMap.values()) };
  }

  // Get existing data from Sheet
  async getExistingSheetData() {
    try {
      const authClient = await this.auth.getClient();
      const response = await sheets.spreadsheets.values.get({
        auth: authClient,
        spreadsheetId: this.spreadsheetId,
        range: 'Funding_Data!A:K',
      });

      const rows = response.data.values || [];
      if (rows.length <= 1) return [];

      // Convert to objects with row index
      return rows.slice(1).map((row, index) => ({
        rowIndex: index + 2, // +2 because: 1 for header, 1 for 0-based index
        company: row[0] || '',
        website: row[1] || '',
        linkedinUrl: row[2] || '',
        fundingAmount: row[3] || '',
        fundingRound: row[4] || '',
        industry: row[5] || '',
        description: row[6] || '',
        sourceLink: row[7] || '',
        investorName: row[8] || '',
        fundingNewsDate: row[9] || '',
        lastUpdated: row[10] || '',
        uniqueKey: this.createUniqueKey(row[0] || '', row[4] || '', row[9] || '')
      }));
    } catch (error) {
      console.error('Error reading existing sheet data:', error.message);
      return [];
    }
  }

  // Update existing row in Sheet
  async updateSheetRow(rowIndex, data) {
    try {
      const authClient = await this.auth.getClient();
      const values = [[
        data.company,
        data.website,
        data.linkedinUrl,
        data.fundingAmount,
        data.fundingRound,
        data.industry,
        data.description,
        data.sourceLink,
        data.investorName,
        data.fundingNewsDate,
        data.lastUpdated
      ]];

      await sheets.spreadsheets.values.update({
        auth: authClient,
        spreadsheetId: this.spreadsheetId,
        range: `Funding_Data!A${rowIndex}:K${rowIndex}`,
        valueInputOption: 'RAW',
        resource: { values }
      });

      console.log(`Updated row ${rowIndex} for ${data.company}`);
    } catch (error) {
      console.error(`Error updating row ${rowIndex}:`, error.message);
    }
  }

  // Append new rows to Sheet
  async appendToSheet(fundingData) {
    if (fundingData.length === 0) {
      console.log('No new funding data to append');
      return;
    }

    try {
      const authClient = await this.auth.getClient();
      const values = fundingData.map(item => [
        item.company,
        item.website,
        item.linkedinUrl,
        item.fundingAmount,
        item.fundingRound,
        item.industry,
        item.description,
        item.sourceLink,
        item.investorName,
        item.fundingNewsDate,
        item.lastUpdated
      ]);

      const response = await sheets.spreadsheets.values.append({
        auth: authClient,
        spreadsheetId: this.spreadsheetId,
        range: 'Funding_Data!A:K',
        valueInputOption: 'RAW',
        resource: { values }
      });

      console.log(`Successfully appended ${response.data.updates.updatedRows} rows to Google Sheet`);
      return response;
    } catch (error) {
      console.error('Error appending to sheet:', error.message);
      throw error;
    }
  }

  // Update source timestamp
  async updateSourceTimestamp(sourceId) {
    try {
      const authClient = await this.auth.getClient();
      const now = new Date().toISOString();

      const response = await sheets.spreadsheets.values.get({
        auth: authClient,
        spreadsheetId: this.spreadsheetId,
        range: 'Sources!A:A',
      });

      const rows = response.data.values || [];
      const rowIndex = rows.findIndex(row => row[0] === sourceId);

      if (rowIndex > 0) {
        await sheets.spreadsheets.values.update({
          auth: authClient,
          spreadsheetId: this.spreadsheetId,
          range: `Sources!F${rowIndex + 1}`,
          valueInputOption: 'RAW',
          resource: { values: [[now]] }
        });
      }
    } catch (error) {
      console.error('Error updating timestamp:', error.message);
    }
  }

  // Main scraping function
  async run() {
    try {
      console.log('Starting funding tracker scraper...');
      console.log('Phase 1: Loading history and sources');

      // Load history
      let history = await this.loadHistory();
      console.log(`Loaded ${history.data.length} historical records`);

      // Clean old data
      history.data = this.cleanOldData(history.data);
      console.log(`After cleanup: ${history.data.length} records (last 30 days)`);

      // Get sources
      const sources = await this.getRSSFeedSources();
      console.log(`Found ${sources.length} active RSS sources`);

      if (sources.length === 0) {
        console.log('No active RSS sources found. Exiting.');
        return;
      }

      console.log('\nPhase 2: Scraping and processing articles');
      const allNewData = [];

      for (const source of sources) {
        console.log(`\nProcessing source: ${source.name}`);
        try {
          const articles = await this.parseFeed(source.url);
          console.log(`Found ${articles.length} articles in ${source.name}`);

          for (const article of articles) {
            const fundingData = await this.processFundingArticle(article, article.link);
            if (fundingData) {
              allNewData.push(fundingData);
            }
          }

          // Update timestamp
          await this.updateSourceTimestamp(source.id);

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Error processing source ${source.name}:`, error.message);
          continue;
        }
      }

      console.log(`\nExtracted ${allNewData.length} potential funding entries`);

      console.log('\nPhase 3: Deduplication and merging');
      const { toAdd, toUpdate, updatedHistory } = await this.deduplicateWithHistory(allNewData, history);
      
      console.log(`New entries to add: ${toAdd.length}`);
      console.log(`Existing entries to update: ${toUpdate.length}`);

      console.log('\nPhase 4: Syncing with Google Sheet');
      
      // Get existing sheet data
      const sheetData = await this.getExistingSheetData();
      const sheetMap = new Map();
      sheetData.forEach(row => {
        sheetMap.set(row.uniqueKey, row);
      });

      // Update existing rows
      for (const item of toUpdate) {
        const sheetRow = sheetMap.get(item.uniqueKey);
        if (sheetRow) {
          await this.updateSheetRow(sheetRow.rowIndex, item);
        }
      }

      // Add new rows
      if (toAdd.length > 0) {
        await this.appendToSheet(toAdd);
      }

      // Save updated history
      history.data = updatedHistory;
      history.lastUpdated = new Date().toISOString();
      await this.saveHistory(history);
      console.log('History file updated');

      console.log('\n✅ Scraping completed successfully!');
      console.log(`Summary: ${toAdd.length} new entries added, ${toUpdate.length} entries updated`);
      
      return {
        success: true,
        entriesAdded: toAdd.length,
        entriesUpdated: toUpdate.length
      };
    } catch (error) {
      console.error('Fatal error in scraper:', error.message);
      throw error;
    }
  }
}

module.exports = FundingScraper;

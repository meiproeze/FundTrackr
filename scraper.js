const RssParser = require('rss-parser');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Initialize Parser
const parser = new RssParser({
  requestOptions: {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }
});

const sheets = google.sheets('v4');

// Configuration
const FUNDING_KEYWORDS = [
  'raised', 'funding', 'series', 'seed', 'investment', 'invested', 
  'round', 'venture capital', 'vc funding', '$', 'million', 'million',
  'backed', 'announces funding', 'secures funding', 'closes funding'
];

class FundingScraper {
  constructor(apiKey, spreadsheetId) {
    this.apiKey = apiKey;
    this.spreadsheetId = spreadsheetId;
    this.auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(apiKey),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  // Initialize Google Sheets API
  async initializeSheets() {
    this.auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(this.apiKey),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
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

  // Get existing companies to check for duplicates
  async getExistingCompanies() {
    try {
      const authClient = await this.auth.getClient();
      const response = await sheets.spreadsheets.values.get({
        auth: authClient,
        spreadsheetId: this.spreadsheetId,
        range: 'Funding_Data!B:B', // Column B contains company names
      });

      const rows = response.data.values || [];
      return rows.map(row => row[0] ? row[0].toLowerCase().trim() : '').filter(name => name);

    } catch (error) {
      console.error('Error reading existing companies:', error.message);
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
    // Try to find company name pattern (usually first meaningful word(s) before key phrases)
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
    const roundRegex = /\b(?:seed|series\s+a|series\s+b|series\s+c|series\s+d|series\s+e|round|angel|pre-seed)\b/gi;

    const fundingMatches = [...text.matchAll(fundingRegex)];
    const roundMatches = [...text.matchAll(roundRegex)];

    let fundingAmount = 'Undisclosed';
    if (fundingMatches.length > 0) {
      const match = fundingMatches[fundingMatches.length - 1];
      fundingAmount = `$${match[1]}${match[2] || 'M'}`;
    }

    let fundingRound = 'Unknown';
    if (roundMatches.length > 0) {
      fundingRound = roundMatches[0][0].charAt(0).toUpperCase() + roundMatches[0][0].slice(1).toLowerCase();
    }

    return { fundingAmount, fundingRound };
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
      const industry = this.extractIndustry(fullText);
      const linkedinUrl = this.generateLinkedInUrl(companyName);

      return {
        date: pubDate,
        companyName: companyName.trim(),
        website: '',
        linkedinUrl: linkedinUrl,
        fundingAmount: fundingAmount,
        fundingRound: fundingRound,
        industry: industry,
        description: description.substring(0, 200),
        sourceLink: sourceLink || article.link || '',
        fundingNewsDate: pubDate
      };

    } catch (error) {
      console.error('Error processing article:', error.message);
      return null;
    }
  }

  // Check if company already exists (case-insensitive)
  isDuplicate(companyName, existingCompanies) {
    const lowerName = companyName.toLowerCase().trim();
    return existingCompanies.some(existing => existing === lowerName);
  }

  // Append data to Google Sheet
  async appendToSheet(fundingData) {
    if (fundingData.length === 0) {
      console.log('No new funding data to append');
      return;
    }

    try {
      const authClient = await this.auth.getClient();
      const values = fundingData.map(item => [
        item.date,
        item.companyName,
        item.website,
        item.linkedinUrl,
        item.fundingAmount,
        item.fundingRound,
        item.industry,
        item.description,
        item.sourceLink,
        item.fundingNewsDate
      ]);

      const response = await sheets.spreadsheets.values.append({
        auth: authClient,
        spreadsheetId: this.spreadsheetId,
        range: 'Funding_Data!A:J',
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

  // Update last checked timestamp for source
  async updateSourceTimestamp(sourceId) {
    try {
      const authClient = await this.auth.getClient();
      const now = new Date().toISOString();

      // Get all sources to find the row index
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
      
      const sources = await this.getRSSFeedSources();
      console.log(`Found ${sources.length} RSS sources`);

      if (sources.length === 0) {
        console.log('No active RSS sources found. Exiting.');
        return;
      }

      const existingCompanies = await this.getExistingCompanies();
      console.log(`Found ${existingCompanies.length} existing companies`);

      const allFundingData = [];

      for (const source of sources) {
        console.log(`\nProcessing source: ${source.name}`);
        
        try {
          const articles = await this.parseFeed(source.url);
          console.log(`Found ${articles.length} articles in ${source.name}`);

          for (const article of articles) {
            const fundingData = await this.processFundingArticle(article, article.link);

            if (fundingData && !this.isDuplicate(fundingData.companyName, existingCompanies)) {
              allFundingData.push(fundingData);
              existingCompanies.push(fundingData.companyName.toLowerCase().trim());
            }
          }

          // Update last checked timestamp
          await this.updateSourceTimestamp(source.id);

          // Rate limiting: 1 second delay between sources
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          console.error(`Error processing source ${source.name}:`, error.message);
          continue; // Continue with next source
        }
      }

      // Append all new funding data to sheet
      if (allFundingData.length > 0) {
        console.log(`\nAppending ${allFundingData.length} new funding entries...`);
        await this.appendToSheet(allFundingData);
      }

      console.log('Scraping completed successfully!');
      return { success: true, entriesAdded: allFundingData.length };

    } catch (error) {
      console.error('Fatal error in scraper:', error.message);
      throw error;
    }
  }
}

module.exports = FundingScraper;

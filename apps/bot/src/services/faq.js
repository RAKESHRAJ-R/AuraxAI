import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAQ_FILE = path.join(__dirname, '../data/faq.json');

class FAQService {
  constructor() {
    this.faqCache = null;
  }

  /**
   * Loads the FAQ list from the JSON store
   */
  getFAQs() {
    if (this.faqCache) return this.faqCache;

    if (!fs.existsSync(FAQ_FILE)) {
      console.warn(`[FAQ Service] FAQ file not found at ${FAQ_FILE}.`);
      return [];
    }

    try {
      const data = fs.readFileSync(FAQ_FILE, 'utf-8');
      this.faqCache = JSON.parse(data);
      return this.faqCache;
    } catch (error) {
      console.error('[FAQ Service] Failed to parse FAQ file:', error.message);
      return [];
    }
  }

  /**
   * Search FAQs by keywords using token-boundary checking for single words
   */
  searchFAQs(query) {
    const faqs = this.getFAQs();
    if (!query) return [];
    
    const cleanQuery = query.toLowerCase().trim();
    const queryTokens = new Set(cleanQuery.split(/[\s/,\-_?!.]+/));

    return faqs.filter((faq) => {
      return faq.keywords.some((kw) => {
        const cleanKw = kw.toLowerCase().trim();
        if (cleanKw.includes(' ')) {
          // Phrase match for multi-word keywords (e.g. "size chart", "cash on delivery")
          return cleanQuery.includes(cleanKw);
        } else {
          // Exact token match for single-word keywords (e.g. "m", "l", "cod") to avoid substring false positives
          return queryTokens.has(cleanKw);
        }
      });
    });
  }
}

const faqService = new FAQService();
export default faqService;

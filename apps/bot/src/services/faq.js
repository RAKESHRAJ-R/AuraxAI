import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAQ_FILE = path.join(__dirname, '../data/faq.json');

// Address terms and chat filler that carry no intent. Stripped before an `exactOnly`
// (greeting) comparison so "hi there" / "Vanakkam bro" still read as bare greetings.
const FILLER_WORDS = new Set([
  'bro', 'ji', 'anna', 'akka', 'sir', 'madam', 'da', 'dei', 'machan', 'machi',
  'thala', 'boss', 'dear', 'there', 'pa', 'ma', 'na',
]);

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

    // For `exactOnly` entries, compare against the message with conversational filler
    // and emoji stripped out, so "Vanakkam bro!" still counts as a bare greeting.
    const core = cleanQuery
      .split(/[\s/,\-_?!.]+/)
      .filter(t => /[a-z0-9]/.test(t) && !FILLER_WORDS.has(t))
      .join(' ');

    return faqs.filter((faq) => {
      // `exactOnly` entries (greetings) match ONLY when the message is nothing BUT the
      // keyword. Without this, "Vanakkam bro, Barcelona jersey irukka?" matches the
      // greeting entry — which sits first in the list — and the customer gets a canned
      // hello instead of a product search. That greeting-hijack has bitten this bot
      // before; it becomes far more likely once Tanglish openers are keywords, because
      // Tanglish customers almost always greet and ask in the SAME message.
      if (faq.exactOnly) {
        return faq.keywords.some(kw => kw.toLowerCase().trim() === core);
      }
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

  /**
   * Pick the reply in the session's language.
   *
   * The FAQ store was English-only, but `session.language` is locked for the whole
   * conversation — so a Tanglish customer hitting a FAQ used to get an abrupt English
   * wall of text, breaking the language rule the system prompt enforces everywhere else.
   * Falls back to English whenever an entry has no Tanglish variant.
   */
  answerFor(faq, language) {
    if (!faq) return null;
    return (language === 'tanglish' && faq.answerTanglish) ? faq.answerTanglish : faq.answer;
  }
}

const faqService = new FAQService();
export default faqService;

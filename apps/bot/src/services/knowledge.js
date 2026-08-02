import dbService from './db.js';

/**
 * Knowledge Hub matcher — the runtime consumer of the client-editable knowledge store
 * (managed via the /knowledge-hub web page). This is the "learn from mistakes" layer:
 * whatever corrections/answers the client saves are matched here and either answered
 * directly (confident match, zero LLM) or injected into the LLM context (soft match) so
 * the model prefers the client's guidance over its own guess.
 *
 * Matching mirrors faq.js (phrase vs single-token keyword matching) but adds a relevance
 * SCORE so we can distinguish a confident hit (answer directly) from a soft hit (nudge the
 * LLM). Entries are cached in memory; call invalidate() after any write so edits go live
 * immediately without a restart.
 */

const PHRASE_POINTS = 10;   // multi-word keyword found as a substring — strong signal
const TOKEN_POINTS = 4;     // single-word keyword matched on a whole-token boundary
const CONFIDENT_SCORE = 8;  // >= one phrase, or >= two single tokens → answer directly
const SOFT_SCORE = 4;       // >= one single token → inject into LLM context as guidance

class KnowledgeService {
  constructor() {
    this.cache = null;
    this.cacheAt = 0;
    this.ttlMs = 60 * 1000; // safety re-read even without an explicit invalidate
  }

  /** Drop the in-memory cache so the next match re-reads fresh entries. Call after writes. */
  invalidate() {
    this.cache = null;
    this.cacheAt = 0;
  }

  async getActive() {
    const now = Date.now();
    if (this.cache && (now - this.cacheAt) < this.ttlMs) return this.cache;
    try {
      this.cache = await dbService.getActiveKnowledge();
    } catch (err) {
      console.warn('[Knowledge Service] Failed to load knowledge entries:', err.message);
      this.cache = [];
    }
    this.cacheAt = now;
    return this.cache;
  }

  scoreEntry(entry, cleanQuery, queryTokens) {
    let score = 0;
    for (const kw of (entry.keywords || [])) {
      const cleanKw = String(kw).toLowerCase().trim();
      if (!cleanKw) continue;
      if (cleanKw.includes(' ')) {
        if (cleanQuery.includes(cleanKw)) score += PHRASE_POINTS;
      } else if (queryTokens.has(cleanKw)) {
        score += TOKEN_POINTS;
      }
    }
    return score;
  }

  /**
   * Returns { entry, score, tier } for the best-matching active entry, or null.
   * tier: 'confident' → answer directly (zero LLM); 'soft' → inject as LLM guidance.
   * language: the session language ('english'|'tanglish'); entries scoped to the other
   * language are ignored ('both' always applies).
   */
  async match(query, language = 'english') {
    if (!query) return null;
    const entries = await this.getActive();
    if (!entries.length) return null;

    const cleanQuery = query.toLowerCase().trim();
    const queryTokens = new Set(cleanQuery.split(/[\s/,\-_?!.]+/).filter(Boolean));

    let best = null;
    for (const entry of entries) {
      if (!entry.answer) continue;
      const lang = entry.language || 'both';
      if (lang !== 'both' && lang !== language) continue;
      const score = this.scoreEntry(entry, cleanQuery, queryTokens);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { entry, score };
    }

    if (!best || best.score < SOFT_SCORE) return null;
    best.tier = best.score >= CONFIDENT_SCORE ? 'confident' : 'soft';
    return best;
  }
}

const knowledgeService = new KnowledgeService();
export default knowledgeService;

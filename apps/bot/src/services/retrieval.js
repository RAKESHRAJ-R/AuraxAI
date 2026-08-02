import dbService from './db.js';
import textExtractService from './textextract.js';
import crawlerService from './crawler.js';
import embeddingService from './embeddings.js';

/**
 * Knowledge source indexing + retrieval — the RAG layer behind the Knowledge Hub's
 * "Document" and "Website" sources.
 *
 * Indexing:  file/URL → plain text → chunks → embeddings → knowledge_chunks
 * Retrieval: customer question → top-N relevant chunks → injected into the LLM prompt
 *
 * Scoring is HYBRID on purpose. Cosine similarity alone is fuzzy and will happily return
 * a vaguely-related chunk for a question the documents don't cover; keyword overlap alone
 * misses paraphrases. Blending them means an exact term match ("XXL", an order number, a
 * team name) still pulls its weight, and the whole thing degrades to plain keyword search
 * when embeddings are unavailable rather than breaking.
 *
 * The chunk set is cached in memory — embeddings are static once indexed, and re-reading
 * a few thousand vectors from the DB on every customer message would be wasteful.
 */

const TOP_K = 3;                  // chunks injected into the prompt — more than this crowds it out
// Below this the "match" is noise; inject nothing.
//
// Retuned 0.28 → 0.33 on 2026-07-30 with the switch to local all-MiniLM-L6-v2. 0.28 was
// tuned against OpenAI text-embedding-3-small, whose cosine range is compressed; MiniLM
// spreads wider, so the old value sat only 0.03 above the noise floor. Calibrated against
// a clean 5-chunk policy corpus (the same one `npm run test-embeddings` builds): on-topic
// queries scored 0.407–0.696, off-topic 0.050–0.248, so anything in (0.248, 0.407]
// separates them — 0.33 is the midpoint and leaves ~0.08 of margin on both sides.
// Erring high is deliberate: a missed retrieval just means the LLM answers as it normally
// would, while a false positive injects misleading text into a customer-facing prompt.
//
// ⚠️ A threshold cannot rescue a corpus that doesn't contain the answer. On the actual
// theaurax.in crawl the two bands OVERLAP ("who won the 1998 world cup" scores 0.367,
// above the genuine "what sizes do you have" at 0.231) because that crawl indexed product
// grids, filter sidebars and customer testimonials — no shipping/returns/sizing prose.
// The fix for that is re-indexing real policy content, not moving this number.
const MIN_SCORE = 0.33;
const EMBED_WEIGHT = 0.75;
const KEYWORD_WEIGHT = 0.25;
const MAX_INJECT_CHARS = 2400;    // hard ceiling on retrieved context per call

// Words too common to signal anything. Includes the Tanglish filler that shows up in
// almost every message ("enna", "irukku", "bro") — without these, keyword scoring
// matches every chunk equally on a Tanglish query.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'do', 'does', 'did', 'you', 'your', 'i', 'me', 'my',
  'we', 'us', 'it', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'if', 'can', 'could',
  'will', 'would', 'have', 'has', 'had', 'be', 'been', 'what', 'when', 'where', 'how', 'why',
  'this', 'that', 'there', 'any', 'please', 'pls', 'sir', 'bro', 'hi', 'hello',
  'enna', 'irukku', 'irukka', 'illa', 'ok', 'okay', 'seri', 'na', 'da', 'ah', 'la', 'um'
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9₹]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

class RetrievalService {
  constructor() {
    this.cache = null;
    this.cacheAt = 0;
    this.ttlMs = 5 * 60 * 1000; // safety re-read; writes call invalidate() anyway
  }

  invalidate() {
    this.cache = null;
    this.cacheAt = 0;
  }

  async getChunks() {
    const now = Date.now();
    if (this.cache && (now - this.cacheAt) < this.ttlMs) return this.cache;
    try {
      const [chunks, sources] = await Promise.all([
        dbService.getAllKnowledgeChunks(),
        dbService.getAllKnowledgeSources(),
      ]);
      // A source the owner switched off must stop being retrievable immediately,
      // without having to re-index or delete it.
      const inactive = new Set(sources.filter((s) => s.active === false).map((s) => s.id));
      this.cache = chunks.filter((c) => !inactive.has(c.sourceId));
    } catch (err) {
      console.warn('[Retrieval Service] Failed to load chunks:', err.message);
      this.cache = [];
    }
    this.cacheAt = now;
    return this.cache;
  }

  /** True when there is anything at all to search — lets callers skip the work entirely. */
  async hasSources() {
    const chunks = await this.getChunks();
    return chunks.length > 0;
  }

  /** Returns { ratio, hits } — hits matters on its own, see the guard in search(). */
  keywordScore(queryTokens, text) {
    if (!queryTokens.length) return { ratio: 0, hits: 0 };
    const haystack = String(text || '').toLowerCase();
    let hits = 0;
    for (const token of queryTokens) {
      if (haystack.includes(token)) hits++;
    }
    return { ratio: hits / queryTokens.length, hits };
  }

  /**
   * Find the most relevant indexed chunks for a query.
   * Returns [{ text, sourceTitle, sourceType, url, score }], best first, possibly empty.
   */
  async search(query, { limit = TOP_K, minScore = MIN_SCORE } = {}) {
    const chunks = await this.getChunks();
    if (!chunks.length || !query) return [];

    const queryTokens = tokenize(query);
    // Only pay for an embedding call if at least one chunk actually has a vector to
    // compare against — with keyword-only indexing this stays completely free.
    const anyEmbedded = chunks.some((c) => Array.isArray(c.embedding));
    const queryVector = anyEmbedded ? await embeddingService.embedOne(query) : null;
    // Vectors from different providers aren't comparable, and the dimensions differ
    // (OpenAI 512, local MiniLM 384). Without this check a provider switch would score
    // every stale chunk at cosine 0 — which is WORSE than keyword-only, because the
    // chunk still looks embedded and so skips the keyword branch entirely. Any chunk
    // whose width doesn't match the live query vector is treated as un-embedded.
    const queryDims = queryVector?.length || 0;

    // Keyword-only mode is far noisier than semantic mode: a single incidental word
    // match ("world" and "cup" appear all over a jersey catalogue) would otherwise clear
    // the blended threshold and inject an irrelevant chunk. When there's no vector to
    // corroborate the match, demand at least two distinct query terms and a higher ratio.
    const keywordOnlyRatio = 0.5;
    const keywordOnlyMinHits = 2;

    let dimMismatches = 0;
    const scored = [];
    for (const chunk of chunks) {
      const keyword = this.keywordScore(queryTokens, chunk.text);
      const usableVector = queryVector
        && Array.isArray(chunk.embedding)
        && chunk.embedding.length === queryDims;
      if (queryVector && Array.isArray(chunk.embedding) && !usableVector) dimMismatches++;
      let score;
      if (usableVector) {
        const cosine = embeddingService.cosine(queryVector, chunk.embedding);
        score = (EMBED_WEIGHT * cosine) + (KEYWORD_WEIGHT * keyword.ratio);
      } else {
        // A one-word query ("XXL?", "COD?") can only ever score one hit — don't
        // penalise it out of existence, just require that single term to be the
        // whole query.
        const enoughHits = queryTokens.length < keywordOnlyMinHits
          ? keyword.hits >= 1
          : keyword.hits >= keywordOnlyMinHits;
        score = (enoughHits && keyword.ratio >= keywordOnlyRatio) ? keyword.ratio : 0;
      }
      if (score >= minScore) {
        scored.push({
          text: chunk.text,
          sourceTitle: chunk.sourceTitle,
          sourceType: chunk.sourceType,
          url: chunk.url,
          score,
        });
      }
    }

    if (dimMismatches) {
      console.warn(
        `[Retrieval Service] ${dimMismatches} chunk(s) were embedded with a different model ` +
        `(${embeddingService.model} is ${queryDims}d now) and scored keyword-only. ` +
        'Re-index those sources to restore semantic search on them.'
      );
    }

    scored.sort((a, b) => b.score - a.score);

    // Trim to the character ceiling as well as the count — three long chunks can still
    // blow the prompt budget the token-trimming work was meant to protect.
    const out = [];
    let chars = 0;
    for (const hit of scored.slice(0, limit)) {
      if (chars + hit.text.length > MAX_INJECT_CHARS) break;
      out.push(hit);
      chars += hit.text.length;
    }
    return out;
  }

  /**
   * Format retrieved chunks as a system message for the LLM. Returns null when there's
   * nothing relevant, so the caller injects nothing and pays no tokens.
   */
  async buildContextMessage(query) {
    let hits = [];
    try {
      hits = await this.search(query);
    } catch (err) {
      console.warn('[Retrieval Service] Search failed:', err.message);
      return null;
    }
    if (!hits.length) return null;

    const body = hits
      .map((h, i) => `[${i + 1}] From "${h.sourceTitle}"${h.url ? ` (${h.url})` : ''}:\n${h.text}`)
      .join('\n\n');

    return {
      role: 'system',
      content:
        'REFERENCE MATERIAL from the store owner\'s uploaded documents and website. Use it to answer ' +
        'the customer\'s current question if it is relevant. If it does not answer their question, ignore ' +
        'it and continue normally — do NOT mention these documents, and never invent product names, ' +
        'prices, or links from them.\n\n' + body,
      _hits: hits.length,
    };
  }

  /** Embed chunk texts, tolerating an embedding outage by falling back to keyword-only. */
  async embedChunks(texts) {
    const vectors = await embeddingService.embed(texts);
    if (!vectors || vectors.length !== texts.length) return null;
    return vectors;
  }

  async persist(source, pieces) {
    const texts = pieces.map((p) => p.text);
    const vectors = await this.embedChunks(texts);

    const chunkRecords = pieces.map((p, i) => ({
      sourceTitle: p.sourceTitle || source.title,
      sourceType: source.type,
      url: p.url || source.url,
      text: p.text,
      embedding: vectors ? vectors[i] : null,
      // Stamped so a later provider/model change is diagnosable rather than a mystery
      // drop in retrieval quality — search() warns on any width that no longer matches.
      embeddingModel: vectors ? embeddingService.model : null,
    }));

    const saved = await dbService.saveKnowledgeSource({
      ...source,
      chunkCount: chunkRecords.length,
      charCount: texts.reduce((n, t) => n + t.length, 0),
      embedded: Boolean(vectors),
      embeddingModel: vectors ? embeddingService.model : null,
      status: 'ready',
    });
    await dbService.replaceKnowledgeChunks(saved.id, chunkRecords);
    this.invalidate();

    return {
      source: saved,
      chunks: chunkRecords.length,
      embedded: Boolean(vectors),
      embeddingNote: vectors ? null : (embeddingService.disabledReason
        ? `Embedding unavailable (${embeddingService.disabledReason}) — indexed with keyword search only.`
        : 'Embedding failed — indexed with keyword search only.'),
    };
  }

  /** Index an uploaded file. Throws with a human-readable message on bad input. */
  async indexDocument(buffer, filename, { language = 'both', title } = {}) {
    const extracted = await textExtractService.fromBuffer(buffer, filename);
    const chunks = textExtractService.chunk(extracted.text);
    if (!chunks.length) throw new Error('Could not split this file into any usable text.');

    return this.persist(
      {
        type: 'document',
        title: (title || '').trim() || extracted.title || filename,
        filename,
        pageCount: extracted.pages,
        language,
      },
      chunks.map((text) => ({ text }))
    );
  }

  /** Crawl and index a website. Throws with a human-readable message if the site blocks us. */
  async indexWebsite(url, { language = 'both', maxPages, maxDepth, title } = {}) {
    const result = await crawlerService.crawl(url, { maxPages, maxDepth });

    const pieces = [];
    for (const page of result.pages) {
      for (const text of textExtractService.chunk(page.text)) {
        pieces.push({ text, url: page.url, sourceTitle: page.title });
      }
    }
    if (!pieces.length) throw new Error('Crawled the site but found no indexable text.');

    const out = await this.persist(
      {
        type: 'website',
        title: (title || '').trim() || result.pages[0].title || url,
        url,
        pageCount: result.pages.length,
        language,
      },
      pieces
    );
    out.pagesCrawled = result.pages.length;
    out.crawlErrors = result.errors;
    return out;
  }
}

const retrievalService = new RetrievalService();
export default retrievalService;

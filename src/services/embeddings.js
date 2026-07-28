import OpenAI from 'openai';
import config from '../config/config.js';

/**
 * Embedding provider for Knowledge Hub semantic search.
 *
 * Keyword matching is fine for short Q&A pairs (that's what knowledge.js and faq.js do)
 * but falls apart on long documents, where the customer's wording rarely overlaps the
 * document's. Embeddings fix that — "do you post overseas" finds a chunk about
 * international delivery with zero shared words, and they absorb Tanglish spelling
 * variation ("jursey"/"jersey") that exact token matching misses.
 *
 * Uses OpenAI text-embedding-3-small at 512 dimensions (down from the default 1536 —
 * 3x less memory and storage per chunk for a negligible quality drop at this corpus
 * size). Cost is effectively zero: embedding a whole 1MB knowledge base is a fraction
 * of a cent, and a customer query is ~20 tokens.
 *
 * ENTIRELY OPTIONAL. With no OPENAI_API_KEY the service reports disabled and the
 * retrieval layer silently falls back to keyword scoring — the bot still works, it just
 * matches less cleverly. Nothing here is on the critical path of a sale.
 */

const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const DIMENSIONS = 512;
const BATCH_SIZE = 96;       // stay well under the per-request input cap
const MAX_INPUT_CHARS = 8000; // hard truncate; our chunks are ~900 chars anyway

class EmbeddingService {
  constructor() {
    this.client = null;
    this.disabledReason = null;
  }

  get model() {
    return MODEL;
  }

  get dimensions() {
    return DIMENSIONS;
  }

  isEnabled() {
    return Boolean(config.openai?.apiKeys?.length);
  }

  getClient() {
    if (this.client) return this.client;
    const key = config.openai?.apiKeys?.[0];
    if (!key) return null;
    this.client = new OpenAI({ apiKey: key });
    return this.client;
  }

  /**
   * Embed an array of strings. Returns an array of Float32-ish number[] vectors,
   * aligned with the input, or null if embeddings are unavailable.
   *
   * Returns null rather than throwing on failure: a knowledge source that can't be
   * embedded should still be saved and keyword-searchable, not rejected outright.
   */
  async embed(texts) {
    const inputs = (Array.isArray(texts) ? texts : [texts])
      .map((t) => String(t || '').slice(0, MAX_INPUT_CHARS).trim())
      .filter(Boolean);
    if (!inputs.length) return [];

    const client = this.getClient();
    if (!client) {
      this.disabledReason = 'OPENAI_API_KEY is not set';
      return null;
    }

    try {
      const vectors = [];
      for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
        const batch = inputs.slice(i, i + BATCH_SIZE);
        const res = await client.embeddings.create({
          model: MODEL,
          input: batch,
          dimensions: DIMENSIONS
        });
        // The API guarantees order, but sort by index defensively — a mis-ordered
        // batch would silently attach the wrong vector to every chunk.
        const sorted = [...res.data].sort((a, b) => a.index - b.index);
        for (const item of sorted) vectors.push(item.embedding);
      }
      this.disabledReason = null;
      return vectors;
    } catch (err) {
      console.warn('[Embedding Service] Embedding failed, falling back to keyword search:', err.message);
      this.disabledReason = err.message;
      return null;
    }
  }

  /** Embed a single string. Returns number[] or null. */
  async embedOne(text) {
    const out = await this.embed([text]);
    return out && out.length ? out[0] : null;
  }

  /**
   * Cosine similarity. OpenAI embeddings are already L2-normalised, so this is
   * effectively a dot product, but the norms are computed anyway so the function
   * stays correct if the provider ever changes.
   */
  cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

const embeddingService = new EmbeddingService();
export default embeddingService;

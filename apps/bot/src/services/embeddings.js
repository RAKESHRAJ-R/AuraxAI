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
 * TWO PROVIDERS, local is the default (switched 2026-07-30):
 *
 *   local  — all-MiniLM-L6-v2 via @huggingface/transformers, 384 dims, ONNX int8 on CPU.
 *            No API key, no quota, no per-call cost, and no store content leaves the box.
 *            ~130 MB RSS once loaded, ~17 ms per 900-char chunk, ~5 ms per query.
 *   openai — text-embedding-3-small @ 512 dims. Kept working for anyone with a funded
 *            key, but it is no longer the default: the account's key has been returning
 *            `429 exceeded your current quota` since ~2026-07-28, which is what left the
 *            whole knowledge base indexed keyword-only.
 *
 * Select with EMBEDDING_PROVIDER=local|openai. `local` needs nothing else; `openai`
 * falls back to `local` if no key is configured rather than silently disabling search.
 *
 * STILL ENTIRELY OPTIONAL. Every method returns null instead of throwing, and the
 * retrieval layer degrades to keyword scoring — the bot keeps working, it just matches
 * less cleverly. Nothing here is on the critical path of a sale.
 */

const LOCAL_MODEL = process.env.LOCAL_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const LOCAL_DIMENSIONS = 384;
// int8-quantised ONNX. ~4x smaller and ~3x faster than fp32 for a similarity delta too
// small to matter at this corpus size — and the KVM 2 target has only 2 vCPU to spare.
const LOCAL_DTYPE = process.env.LOCAL_EMBEDDING_DTYPE || 'q8';
// Small batches keep peak memory flat. The bot shares its RAM with a headless Chromium
// that spikes hard, so a 149-chunk crawl must not allocate 149 tensors at once.
const LOCAL_BATCH_SIZE = 16;

const OPENAI_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const OPENAI_DIMENSIONS = 512;
const OPENAI_BATCH_SIZE = 96;   // stay well under the per-request input cap

const MAX_INPUT_CHARS = 8000;   // hard truncate; our chunks are ~900 chars anyway

class EmbeddingService {
  constructor() {
    this.openaiClient = null;
    this.extractor = null;
    // Concurrent callers must share ONE model load. Without this, three simultaneous
    // requests each start their own 100 MB load before any of them finishes.
    this.extractorPromise = null;
    this.disabledReason = null;

    const requested = (config.embeddings?.provider || 'local').toLowerCase();
    const hasOpenAiKey = Boolean(config.openai?.apiKeys?.length);
    if (requested === 'openai' && !hasOpenAiKey) {
      console.warn('[Embedding Service] EMBEDDING_PROVIDER=openai but no OPENAI_API_KEY — using the local model instead.');
      this.provider = 'local';
    } else {
      this.provider = requested === 'openai' ? 'openai' : 'local';
    }
  }

  get model() {
    return this.provider === 'openai' ? OPENAI_MODEL : LOCAL_MODEL;
  }

  get dimensions() {
    return this.provider === 'openai' ? OPENAI_DIMENSIONS : LOCAL_DIMENSIONS;
  }

  /**
   * The local provider needs no key, so embeddings are available by default now.
   * Retrieval still checks per-chunk vectors — "enabled" only means we can produce them.
   */
  isEnabled() {
    if (this.provider === 'openai') return Boolean(config.openai?.apiKeys?.length);
    return true;
  }

  getOpenAiClient() {
    if (this.openaiClient) return this.openaiClient;
    const key = config.openai?.apiKeys?.[0];
    if (!key) return null;
    this.openaiClient = new OpenAI({ apiKey: key });
    return this.openaiClient;
  }

  /**
   * Load the local ONNX model once, lazily.
   *
   * Lazily on purpose: with no knowledge sources indexed, retrieval never calls in here
   * and the bot never pays the ~130 MB. Callers that DO want it warm before the first
   * customer question should call warmup() at boot.
   */
  async getExtractor() {
    if (this.extractor) return this.extractor;
    if (this.extractorPromise) return this.extractorPromise;

    this.extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Default cache lives inside node_modules, which is root-owned on a normal deploy
      // (npm ci as root, app runs as `theaurax`) — the download would fail at runtime.
      // Pin it somewhere the app user owns.
      env.cacheDir = config.embeddings?.cacheDir || './.models';
      const t0 = Date.now();
      const extractor = await pipeline('feature-extraction', LOCAL_MODEL, { dtype: LOCAL_DTYPE });
      console.log(`[Embedding Service] Local model ready: ${LOCAL_MODEL} (${LOCAL_DIMENSIONS}d, ${LOCAL_DTYPE}) in ${Date.now() - t0}ms`);
      this.extractor = extractor;
      this.disabledReason = null;
      return extractor;
    })().catch((err) => {
      // First load downloads ~30 MB from the HF hub. On a box with no outbound access,
      // report it and let retrieval fall back to keyword scoring rather than crashing.
      console.warn('[Embedding Service] Local model failed to load, falling back to keyword search:', err.message);
      this.disabledReason = `Local model load failed: ${err.message}`;
      this.extractorPromise = null;
      return null;
    });

    return this.extractorPromise;
  }

  /** Preload the model so the first customer question doesn't pay the load time. */
  async warmup() {
    if (this.provider !== 'local') return false;
    const extractor = await this.getExtractor();
    return Boolean(extractor);
  }

  /**
   * Embed an array of strings. Returns an array of number[] vectors aligned with the
   * input, or null if embeddings are unavailable.
   *
   * Returns null rather than throwing on failure: a knowledge source that can't be
   * embedded should still be saved and keyword-searchable, not rejected outright.
   */
  async embed(texts) {
    const inputs = (Array.isArray(texts) ? texts : [texts])
      .map((t) => String(t || '').slice(0, MAX_INPUT_CHARS).trim())
      .filter(Boolean);
    if (!inputs.length) return [];

    return this.provider === 'openai'
      ? this.embedWithOpenAi(inputs)
      : this.embedLocally(inputs);
  }

  async embedLocally(inputs) {
    const extractor = await this.getExtractor();
    if (!extractor) return null;

    try {
      const vectors = [];
      for (let i = 0; i < inputs.length; i += LOCAL_BATCH_SIZE) {
        const batch = inputs.slice(i, i + LOCAL_BATCH_SIZE);
        // Mean pooling + L2 normalise reproduces what sentence-transformers does for
        // this model — without it you get raw per-token states, not a usable sentence
        // vector, and cosine similarity becomes meaningless.
        const output = await extractor(batch, { pooling: 'mean', normalize: true });
        const rows = output.tolist();
        for (const row of rows) vectors.push(row);
      }
      this.disabledReason = null;
      return vectors;
    } catch (err) {
      console.warn('[Embedding Service] Local embedding failed, falling back to keyword search:', err.message);
      this.disabledReason = err.message;
      return null;
    }
  }

  async embedWithOpenAi(inputs) {
    const client = this.getOpenAiClient();
    if (!client) {
      this.disabledReason = 'OPENAI_API_KEY is not set';
      return null;
    }

    try {
      const vectors = [];
      for (let i = 0; i < inputs.length; i += OPENAI_BATCH_SIZE) {
        const batch = inputs.slice(i, i + OPENAI_BATCH_SIZE);
        const res = await client.embeddings.create({
          model: OPENAI_MODEL,
          input: batch,
          dimensions: OPENAI_DIMENSIONS
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
   * Cosine similarity. Both providers return L2-normalised vectors, so this is
   * effectively a dot product, but the norms are computed anyway so the function
   * stays correct if a provider ever changes.
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

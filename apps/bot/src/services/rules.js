import dbService from './db.js';
import faqService from './faq.js';
import config from '../config/config.js';

/**
 * Owner rule documents — the client's way of changing how the bot behaves without a developer.
 *
 * The client writes their business rules as a document (the first was the 13-page
 * "AURA EXCHANGE WhatsApp Chatbot Master Training Guide", 2026-09-28) and uploads it in the
 * Knowledge Hub. Before this, an upload only fed the RAG index, and that did nothing useful for
 * a rules document: the static FAQ answered first with contradicting facts, and the local
 * English-only embedding model could not find the right passage for Tanglish questions. Rules
 * also cannot be retrieved "when relevant" — tone and never-do rules apply to every reply.
 *
 * So every uploaded DOCUMENT is condensed ONCE (one LLM call per upload, never per message)
 * into a compact rule sheet, and every active sheet is placed in the system prompt of every
 * call. Newer documents win over older ones. The same call names the built-in FAQ answers the
 * document contradicts, and the FAQ fast path stops using those until the document goes away.
 *
 * Websites stay RAG-only — a crawl is reference material, not instructions.
 */

const MAX_DOC_CHARS = 60000;      // input sent to the condenser; larger documents are truncated
const MAX_RULES_CHARS = 4000;     // per document — every character here is paid on every call
const TTL_MS = 60 * 1000;         // safety re-read; every write calls invalidate() anyway

const CONDENSE_INSTRUCTIONS = `You turn a store owner's document into a rule sheet for their WhatsApp sales assistant (a football-jersey shop in India that chats in English and Tanglish).

Write exactly two sections, in this format and nothing else:

RULES:
- one rule or business fact per line

FAQ_CONFLICTS:
<the category names from the CURRENT FAQ list below whose answer the document contradicts, separated by " | ", or NONE>

How to write RULES:
- Keep every concrete fact EXACTLY as written: prices, amounts, numbers of days, phone numbers, names, product/version names, and any reply wording the document says to use word-for-word.
- Keep every behaviour rule: what the assistant must do, must never do, when to hand over to the team, tone and language rules.
- Drop the examples, test cases, checklists, contents pages and repetition — but keep the rule each example teaches.
- Never add anything that is not in the document. Never soften or change a rule.
- A currency amount may appear garbled as "■300" — that is ₹300.
- At most ${MAX_RULES_CHARS} characters.
- If the document has no rules or business facts for the assistant at all (e.g. it is only a product manual), write "RULES:" followed by the single line NONE.

How to decide FAQ_CONFLICTS:
- A category conflicts when its answer states something the document contradicts (a different price, number, timeline, phone number or policy) or claims something the document says the assistant must not claim.
- Only list categories whose answer really disagrees. Same facts in different words is NOT a conflict.`;

class RulesService {
  constructor() {
    this.cache = null;
    this.cacheAt = 0;
    this.loading = null;
  }

  invalidate() {
    this.cache = null;
    this.cacheAt = 0;
  }

  /** Active rule sheets, oldest first (so the newest sits last and wins ties). */
  async refresh() {
    if (this.cache && Date.now() - this.cacheAt < TTL_MS) return this.cache;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const sources = await dbService.getAllKnowledgeSources();
        this.cache = sources
          .filter(s => s.type === 'document' && s.active !== false && hasRules(s))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
          .map(s => ({
            sourceId: s.id,
            title: s.title,
            createdAt: s.createdAt,
            text: s.rules.text,
            faqConflicts: Array.isArray(s.rules.faqConflicts) ? s.rules.faqConflicts : [],
          }));
      } catch (err) {
        console.warn('[Rules] Could not load owner rules:', err.message);
        this.cache = this.cache || [];
      }
      this.cacheAt = Date.now();
      this.loading = null;
      return this.cache;
    })();
    return this.loading;
  }

  /** Synchronous view for generateSystemPrompt(); callers `await refresh()` first. */
  active() {
    return this.cache || [];
  }

  /**
   * The block that goes into every system prompt. Empty string when there are no rules, so
   * the prompt stays byte-identical to before and the prompt cache is unaffected.
   */
  promptBlock() {
    const docs = this.active();
    if (!docs.length) return '';
    const body = docs.map(d =>
      `[From "${d.title}", uploaded ${String(d.createdAt).slice(0, 10)}]\n${d.text}`).join('\n\n');
    return `OWNER RULES — written by the store owner in their uploaded documents. They are AUTHORITATIVE: follow them exactly. Where they conflict with anything else in this prompt, the OWNER RULES win. Where two documents conflict, the one uploaded LATER wins.
${body}`;
  }

  /** FAQ categories an active document contradicts — the fast path must not answer these. */
  disabledFaqCategories() {
    return new Set(this.active().flatMap(d => d.faqConflicts));
  }

  /** The document's text, rebuilt from its stored chunks (the upload itself is never kept). */
  async sourceText(sourceId) {
    const chunks = (await dbService.getAllKnowledgeChunks())
      .filter(c => c.sourceId === sourceId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return chunks.map(c => c.text).join('\n');
  }

  /**
   * Condense one document into its rule sheet and store it on the source. Never throws: a
   * failure is recorded on the source (status 'error') so the console can show it and offer a
   * retry, and the upload itself still stands.
   */
  async digest(sourceId, { llm = defaultLLM } = {}) {
    const source = (await dbService.getAllKnowledgeSources()).find(s => s.id === sourceId);
    if (!source || source.type !== 'document') return null;

    let rules;
    try {
      let text = await this.sourceText(sourceId);
      if (!text.trim()) throw new Error('The document has no readable text.');
      const truncated = text.length > MAX_DOC_CHARS;
      if (truncated) text = text.slice(0, MAX_DOC_CHARS);

      const faqList = faqService.getFAQs().map(f => `- ${f.category}: ${f.answer}`).join('\n');
      const { content, provider } = await llm([
        { role: 'system', content: CONDENSE_INSTRUCTIONS },
        { role: 'user', content: `CURRENT FAQ (category: answer):\n${faqList}\n\nTHE DOCUMENT ("${source.title}"):\n${text}` },
      ]);
      const parsed = parseDigest(content, faqService.getFAQs().map(f => f.category));
      rules = {
        status: 'ready',
        text: parsed.text,
        faqConflicts: parsed.faqConflicts,
        truncated,
        provider,
        edited: false,
        error: null,
        generatedAt: new Date().toISOString(),
      };
      console.log(`[Rules] "${source.title}" → ${parsed.text === 'NONE' ? 'no rules' : `${parsed.text.length} chars of rules`}; FAQ overridden: ${parsed.faqConflicts.join(', ') || 'none'}`);
    } catch (err) {
      console.warn(`[Rules] Could not read rules from "${source.title}":`, err.message);
      rules = { ...(source.rules || {}), status: 'error', error: err.message, generatedAt: new Date().toISOString() };
    }

    const saved = await dbService.saveKnowledgeSource({ ...source, rules });
    this.invalidate();
    return saved;
  }

  /** Staff correcting the sheet by hand — used verbatim from then on. */
  async setText(sourceId, text) {
    const source = (await dbService.getAllKnowledgeSources()).find(s => s.id === sourceId);
    if (!source || source.type !== 'document') return null;
    const clean = String(text || '').trim().slice(0, MAX_RULES_CHARS * 2);
    const rules = {
      ...(source.rules || {}),
      status: 'ready',
      text: clean || 'NONE',
      edited: true,
      error: null,
      editedAt: new Date().toISOString(),
    };
    const saved = await dbService.saveKnowledgeSource({ ...source, rules });
    this.invalidate();
    return saved;
  }

  /**
   * Documents uploaded before this existed (or whose digest never ran) get one at boot. Each is
   * a single paid LLM call, and a source that failed is NOT retried automatically — it waits for
   * someone to press "Re-read" — so a broken document cannot cost money on every restart.
   */
  async backfill() {
    const sources = await dbService.getAllKnowledgeSources();
    const pending = sources.filter(s => s.type === 'document' && s.active !== false && !s.rules);
    for (const s of pending) await this.digest(s.id);
    if (pending.length) console.log(`[Rules] Read rules from ${pending.length} earlier document(s).`);
  }
}

function hasRules(source) {
  const r = source.rules;
  return r && r.status === 'ready' && r.text && r.text.trim() !== 'NONE';
}

/** Split the condenser's reply into the rule text and the FAQ categories it overrides. */
export function parseDigest(content, knownCategories) {
  const raw = String(content || '').replace(/\r/g, '');
  // `[ \t]*`, not `\s*`: \s would swallow the newlines before FAQ_CONFLICTS, and an empty
  // rule sheet would then read the conflicts line in as its "rules".
  const rulesMatch = raw.match(/RULES:[ \t]*([\s\S]*?)(?:\n[ \t]*FAQ_CONFLICTS:|$)/i);
  const conflictsMatch = raw.match(/FAQ_CONFLICTS:\s*([\s\S]*)$/i);
  const text = (rulesMatch ? rulesMatch[1] : raw).trim().slice(0, MAX_RULES_CHARS * 2);
  if (!text) throw new Error('The model returned no rules.');

  const known = new Map(knownCategories.map(c => [c.toLowerCase(), c]));
  const faqConflicts = conflictsMatch && !/^\s*NONE\b/i.test(conflictsMatch[1])
    ? [...new Set(conflictsMatch[1].split(/[|\n,]/)
        .map(c => c.replace(/^[\s\-*•]+|[\s.]+$/g, '').toLowerCase())
        .filter(c => known.has(c))
        .map(c => known.get(c)))]
    : [];
  return { text, faqConflicts };
}

/**
 * One plain completion through the same providers the bot uses (Sarvam → Fireworks → Groq),
 * no tools. Imported lazily: ai.js imports this module, so a top-level import would be circular.
 */
async function defaultLLM(messages) {
  const { default: ai } = await import('./ai.js');
  const candidates = [
    ...ai.sarvamClients.map(c => ({ c, provider: 'sarvam', model: config.sarvam.model, extra: {} })),
    ...ai.fireworksClients.map(c => ({ c, provider: 'fireworks', model: config.fireworks.model, extra: {} })),
    ...ai.groqClients.map(c => ({ c, provider: 'groq', model: config.groq.model, extra: {} })),
  ];
  if (!candidates.length) throw new Error('No AI provider is configured to read the document.');
  let lastErr;
  for (const { c, provider, model } of candidates) {
    try {
      const msgs = provider === 'sarvam'
        ? messages.map((m, i) => (i === 0 ? { ...m, content: `${m.content} /no_think` } : m))
        : messages;
      const r = await c.chat.completions.create({ model, messages: msgs, max_tokens: 3000, temperature: 0.1 });
      const content = r.choices?.[0]?.message?.content;
      if (content && content.trim()) return { content, provider };
      lastErr = new Error(`${provider} returned an empty reply`);
    } catch (err) {
      lastErr = err;
      console.warn(`[Rules] ${provider} failed while reading a document:`, err.message);
    }
  }
  throw lastErr || new Error('Every AI provider failed while reading the document.');
}

const rulesService = new RulesService();
export default rulesService;

import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config/config.js';
import faqService from './faq.js';
import knowledgeService from './knowledge.js';
import retrievalService from './retrieval.js';
import woocommerceService from './woocommerce.js';
import dbService from './db.js';
// NOTE: invoice.js is no longer imported here. The proforma PDF used to be attached when
// WooCommerce order creation FAILED, which made a non-existent order look official. The
// generator still exists for the paid-order invoice in the payment-lifecycle work.
import whatsappWebBot from './whatsapp-web-bot.js';
import sheetsService from './sheets.js';
import orderState from './orderState.js';
import rulesService, { numbersIn } from './rules.js';
import * as tanglishReader from './tanglish.js';
import understandService from './understand.js';

// "1, 2 illa 3?" was asked over a list of TWO Brazil shirts (2026-10-02). Ask for the numbers shown.
function pickRange(n, tanglish) {
  if (n <= 1) return '1';
  if (n === 2) return tanglish ? '1 illa 2' : '1 or 2';
  if (n === 3) return tanglish ? '1, 2 illa 3' : '1, 2, or 3';
  return `1–${n}`;
}

class AIService {
  // --- Per-(provider, key) rate-limit throttling ---
  // Groq/Gemini/etc RPM limits are granted PER API KEY, not per provider. Throttling
  // by provider name alone (the old behavior) forced every key of a provider to share
  // one timer, so 5 Groq keys gave zero extra throughput over 1 key — they only ever
  // helped as error-triggered failover, never as parallel capacity. Keying the timer by
  // "provider#keyIndex" lets each key run on its own clock, so N keys really do give
  // up to N× the throughput under concurrent load.
  // Groq free tier: 30 RPM/key → 2s gap. Gemini free: 60 RPM/key → ~1.5s gap.
  // OpenAI: 500 RPM → ~666ms gap. OpenRouter: varies, ~1s conservative.
  static lastApiCallTimes = {};
  static minApiGapMs = {
    groq: 2000,
    openai: 666,
    openrouter: 1000,
    gemini: 1500,
    // Fireworks and Sarvam were missing here and silently fell through to the 1000ms
    // default — a problem once Fireworks became the English primary and Sarvam the
    // Tanglish primary, since each runs on a SINGLE key (no rotation to spread load).
    // Both are paid, so the constraint is account concurrency rather than a free-tier
    // RPM cliff; 900ms/750ms are conservative starting points. Raise the throughput by
    // adding more comma-separated keys to .env (rotation then multiplies it), not by
    // shrinking these.
    fireworks: 900,
    sarvam: 750,
  };
  // Per-key serialisation chains for the throttle. See callWithThrottle().
  static throttleChains = {};
  // Round-robin cursor per provider so consecutive requests spread across keys instead
  // of every request piling onto key[0] first (which is what starves the other keys).
  static roundRobinIndex = {};

  /**
   * Spaces out calls so a provider key never gets hit faster than its rate limit allows.
   *
   * This MUST serialise. The obvious implementation — read the last-call timestamp,
   * sleep the difference, then write the timestamp — is a barrier, not a rate limiter:
   * N concurrent callers all read the SAME timestamp before any of them has written it,
   * all sleep the same amount, and then all fire simultaneously. Under sequential load
   * (every test we've ever run) it looks perfect; under a real burst — 100 customers
   * messaging after a reel drops — it lets the whole burst through at once, which earns
   * a wall of 429s and then MAX_ATTEMPTS × exponential backoff on every one of them.
   * Slower and more fragile than having queued properly in the first place.
   *
   * So each (provider, key) gets its own promise chain: a caller joins the back of the
   * queue, and only reads/writes the clock once it's actually at the front. Same pattern
   * as senderChains in whatsapp-web-bot.js. Different keys still run fully in parallel,
   * which is the entire point of key rotation.
   */
  async callWithThrottle(fn, provider = 'groq', keyIndex = 0) {
    const minGap = AIService.minApiGapMs[provider] || 1000;
    const timerKey = `${provider}#${keyIndex}`;

    const previous = AIService.throttleChains[timerKey] || Promise.resolve();
    // The turn resolves once this caller has waited out its slot — it does NOT include
    // fn() itself, so the next caller can start its gap while this request is in flight.
    const turn = previous.then(async () => {
      const lastCall = AIService.lastApiCallTimes[timerKey] || 0;
      const elapsed = Date.now() - lastCall;
      if (lastCall && elapsed < minGap) {
        await new Promise(r => setTimeout(r, minGap - elapsed));
      }
      AIService.lastApiCallTimes[timerKey] = Date.now();
    });
    // Never let one caller's failure poison the queue behind it.
    AIService.throttleChains[timerKey] = turn.then(() => {}, () => {});

    await turn;
    return fn();
  }

  constructor() {
    // Per-customer turn lock — see answerQuery(). Keyed by senderId, value is the tail of
    // that customer's promise chain.
    this._senderLocks = new Map();
    // Per-turn bookkeeping for the optimistic-version retry (conflict / side effects).
    this._turnMeta = new Map();

    // --- Primary LLM Provider (Groq) — supports multiple API keys for rotation ---
    this.groqClients = (config.groq.apiKeys || []).map(key => new OpenAI({
      apiKey: key,
      baseURL: 'https://api.groq.com/openai/v1'
    }));
    if (this.groqClients.length > 0) {
      console.log(`[AI Service] Loaded ${this.groqClients.length} Groq API key(s) for rotation.`);
    } else {
      console.warn('[AI Service] No GROQ_API_KEY found!');
    }

    // --- Secondary LLM Provider (OpenAI fallback) — supports multiple API keys ---
    this.openaiClients = (config.openai.apiKeys || []).map(key => new OpenAI({ apiKey: key }));
    if (this.openaiClients.length > 0) {
      console.log(`[AI Service] Loaded ${this.openaiClients.length} OpenAI API key(s) as fallback.`);
    } else {
      this.openaiClients = [];
    }

    // --- OpenRouter Provider (Fallback) ---
    this.openrouterClients = (config.openrouter?.apiKeys || []).map(key => new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': config.baseUrl,
        'X-Title': 'Theaurax AI',
      }
    }));
    if (this.openrouterClients.length > 0) {
      console.log(`[AI Service] Loaded ${this.openrouterClients.length} OpenRouter API key(s) as fallback.`);
    } else {
      this.openrouterClients = [];
    }

    // --- Fireworks Provider (paid, client-supplied) — OpenAI-compatible, supports multiple keys ---
    this.fireworksClients = (config.fireworks?.apiKeys || []).map(key => new OpenAI({
      apiKey: key,
      baseURL: 'https://api.fireworks.ai/inference/v1',
    }));
    if (this.fireworksClients.length > 0) {
      console.log(`[AI Service] Loaded ${this.fireworksClients.length} Fireworks API key(s) (model: ${config.fireworks?.model}).`);
    } else {
      this.fireworksClients = [];
    }

    // --- Sarvam Provider (Indic-specialised, paid) — OpenAI-compatible, supports multiple keys ---
    // Tanglish-first provider: purpose-trained on romanized/code-mixed Tamil. Bearer-auth,
    // OpenAI-compatible /v1/chat/completions with full tool-calling support.
    this.sarvamClients = (config.sarvam?.apiKeys || []).map(key => new OpenAI({
      apiKey: key,
      baseURL: 'https://api.sarvam.ai/v1',
    }));
    if (this.sarvamClients.length > 0) {
      console.log(`[AI Service] Loaded ${this.sarvamClients.length} Sarvam API key(s) (model: ${config.sarvam?.model}).`);
    } else {
      this.sarvamClients = [];
    }

    // --- Tertiary LLM Provider (Gemini fallback) — supports multiple API keys ---
    this.geminiClients = (config.gemini.apiKeys || []).map(key => new GoogleGenerativeAI(key));
    if (this.geminiClients.length > 0) {
      console.log(`[AI Service] Loaded ${this.geminiClients.length} Gemini API key(s) as fallback.`);
    } else {
      this.geminiClients = [];
    }

    // Track which provider + key index we're currently using
    this.activeProvider = this.groqClients.length > 0 ? 'groq' : (this.openaiClients.length > 0 ? 'openai' : 'gemini');
    this.activeKeyIndex = 0;

    // --- Provider Analytics (counters for monitoring usage & quota issues) ---
    this.providerStats = {
      groq: { success: 0, errors: 0, quotaExhausted: 0, tokensUsed: 0, lastErrorAt: null, lastErrorMsg: null },
      openai: { success: 0, errors: 0, quotaExhausted: 0, tokensUsed: 0, lastErrorAt: null, lastErrorMsg: null },
      openrouter: { success: 0, errors: 0, quotaExhausted: 0, tokensUsed: 0, lastErrorAt: null, lastErrorMsg: null },
      fireworks: { success: 0, errors: 0, quotaExhausted: 0, tokensUsed: 0, lastErrorAt: null, lastErrorMsg: null },
      sarvam: { success: 0, errors: 0, quotaExhausted: 0, tokensUsed: 0, lastErrorAt: null, lastErrorMsg: null },
      gemini: { success: 0, errors: 0, quotaExhausted: 0, tokensUsed: 0, lastErrorAt: null, lastErrorMsg: null },
    };
    this.totalCalls = 0;
    this.totalErrors = 0;
    this.totalTokensUsed = 0;
    this.callRecords = [];
    this.appStartTime = Date.now();

    // Per-key (not per-provider) quota exhaustion timestamps — keyed by "provider#keyIndex".
    // Lets one exhausted Groq key cool down without benching its sibling keys.
    this.keyExhaustedUntil = {};
  }

  /**
   * Deterministic Tanglish/Tamil detector — runs before any LLM call, zero cost.
   * Checks for Tamil Unicode script or common Tanglish/Tamil-in-Roman-script words.
   * The LLM is unreliable at both detecting this itself AND staying consistent
   * turn-to-turn, so the decision is made once in code and locked into the session.
   */
  detectLanguage(text) {
    if (!text) return null;
    if (/[஀-௿]/.test(text)) return 'tanglish'; // Tamil script present
    const tanglishWords = /\b(bro|machan|machi|da|di|anna|akka|thala|mapla|iruka|irukka|irukku|iruku|vennum|venum|vendum|poda|podi|illa|ila|enna|soldra|solra|sollunga|epdi|eppadi|saptiya|vanga|vanakkam|seri|aiyo|ayyo|kandippa|semma|super|nalla|romba|konjam|please pannunga|thanks bro)\b/i;
    // Everyday verbs and question words, none of them an English word. Without these, "Hi new
    // order place pannanum" opened a returning Tanglish customer's chat in English (2026-10-02)
    // — the language is re-detected after 6h idle, and this list had no "pannanum".
    const tanglishCommon = /\b(pann(?:anum|unga|uren|ren|iten|itten|itenga|alama|ala|uvom|ra|unga)|kaat(?:tunga|unga|turen|uren|u)|kudu(?:nga|kuren|ka)|venaam|vendaam|venam|pudhusa|pudusa|theriyathu|theriyala|teriyala|puriyala|purila|evlo|evalo|evolo|ethana|eppo|yepo|epo|aagum|agum|varum|varuma|varathuku|vidu|vidunga|podhum|pothum|sari|ennaku|enaku|yennaku|neenga|unga|ungaluku|kitta|mattum|matum|thaan|dhaan|illama|athula|idhula|onnu|sluren|solren)\b/i;
    return tanglishWords.test(text) || tanglishCommon.test(text) ? 'tanglish' : 'english';
  }

  /* ────────────────────────────────────────────────────────────────────────────
   * OUTGOING-MESSAGE HYGIENE (added 2026-09-22)
   *
   * A live Tanglish chat on 2026-09-21 put two pieces of machine output in front of a real
   * customer, inside otherwise normal sentences:
   *     "best options kaanpida*ven*! 🔥"          <- markdown emphasis wedged mid-word
   *     "3 jersey ready p\"{ Oru pechu sollu"     <- a raw JSON/escape fragment
   * Neither was caught. The stripping that existed ran ONLY inside the agentic loop's
   * free-text branch, and only matched leaks that were a whole, well-formed tool call —
   * an escape fragment in the middle of a sentence sailed straight through, and nothing
   * anywhere looked at asterisks.
   *
   * So cleaning is now a property of the exit, not of one branch: every reply the bot
   * produces — deterministic template, FAQ, knowledge hit, LLM narration, error path —
   * passes through sanitizeOutgoing() exactly once, at the single egress in answerQuery().
   * A path added later is covered automatically rather than needing to remember.
   *
   * Two distinct jobs, deliberately kept apart:
   *   looksCorrupted()  — structural machine output (braces, backslashes, tool names,
   *                       chat-template tags, JSON keys). Unambiguous, so it is worth
   *                       spending one regeneration on inside the loop.
   *   sanitizeOutgoing() — repairs and strips. Never asks a model for anything, so it is
   *                       free and cannot itself fail. It is the guarantee; the
   *                       regeneration above is only an attempt at a better answer.
   * ──────────────────────────────────────────────────────────────────────────── */

  // Kept as one source of truth so the sanitizer and the detector cannot drift from
  // getTools(). test_tanglish.js asserts this list still covers every registered tool.
  toolNames() {
    return [
      'search_products', 'update_cart', 'set_shipping_address', 'confirm_order',
      'escalate_to_human', 'lookup_order', 'create_support_ticket',
    ];
  }

  /**
   * Does this text still read as machine output rather than as a message from a shop?
   *
   * Structural signals only. Braces and backslashes are the load-bearing ones: no jersey,
   * price, size, URL or Tanglish sentence has ever legitimately contained `{`, `}` or `\`,
   * so their presence is proof of a leak no matter how well-formed the rest of the reply
   * looks. That is exactly the case the old whole-message JSON test missed.
   */
  looksCorrupted(text) {
    const t = String(text || '');
    if (!t.trim()) return true;
    if (/[{}\\]/.test(t)) return true;
    if (/<\/?(?:function|tool_call|tool|think|reasoning|scratchpad)\b/i.test(t)) return true;
    if (/<\|[^|>]*\|>/.test(t)) return true;
    if (/\[\/?(?:INST|SYS|TOOL_CALL|TOOL_RESULT)\]/i.test(t)) return true;
    if (/"(?:function|name|type|arguments|parameters|query|productId|tool_calls)"\s*:/i.test(t)) return true;
    if (new RegExp(`\\b(?:${this.toolNames().join('|')})\\b`).test(t)) return true;
    return false;
  }

  /**
   * Strip every known leak shape and repair broken markdown. Returns '' when nothing
   * usable survives, which the caller turns into an honest apology rather than sending
   * whitespace. Pure string work: no network, no model, cannot throw on odd input.
   */
  sanitizeOutgoing(text) {
    let t = String(text == null ? '' : text);
    const tools = this.toolNames().join('|');

    // 1. Reasoning traces and chat-template scaffolding. The unclosed variants matter more
    //    than the closed ones — a reply truncated at max_tokens mid-<think> has no closer.
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
    t = t.replace(/<(?:think|reasoning|scratchpad)\b[^>]*>[\s\S]*/gi, ' ');
    t = t.replace(/<\|[^|>]*\|>/g, ' ');
    t = t.replace(/\[\/?(?:INST|SYS|TOOL_CALL|TOOL_RESULT)\]/gi, ' ');

    // 2. Tool-call leaks, most specific shape first so a well-formed call is removed whole
    //    rather than being shredded into orphan punctuation by the broader rules below.
    t = t.replace(/<function[^>]*>[\s\S]*?<\/function>/gi, ' ');
    t = t.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ');
    t = t.replace(/<\/?(?:function|tool_call|tool)\b[^>]*>?/gi, ' ');
    t = t.replace(/\{\s*"(?:type|name|function|tool|arguments|parameters)"[\s\S]*?\}\s*\}?/gi, ' ');
    t = t.replace(new RegExp(`\\b(?:${tools})\\s*\\(?\\s*\\{[\\s\\S]*?\\}\\s*\\)?`, 'gi'), ' ');
    t = t.replace(new RegExp(`\\b(?:${tools})\\b`, 'gi'), ' ');
    //    A quoted JSON key outlives its own braces once the rules above have taken them
    //    away, leaving `"tool_calls": [ ]` sitting in the sentence with nothing corrupt
    //    left for the brace rule below to catch.
    t = t.replace(/"(?:function|name|type|arguments|parameters|query|productId|tool_calls|role|content)"\s*:\s*(?:\[\s*\]|"[^"]*"|[\w.\-]+)?/gi, ' ');

    // 3. Whatever fragment is left. A single word carrying a brace or a backslash is
    //    removed ENTIRELY, not character by character: "p\"{" cleaned character-wise
    //    leaves a stray "p" sitting in the sentence, which reads as a typo the customer
    //    will ask about. Whole-token removal is the only version that reads cleanly.
    t = t.replace(/\S*[{}\\]\S*/g, ' ');
    //    An empty bracket pair is debris too. A populated one is a size list — "[S, M, L]"
    //    appears in every product reply the bot sends — so only the empty pair goes.
    t = t.replace(/\[\s*\]/g, ' ');

    // 4. Control and zero-width characters — invisible in a terminal, visible as boxes on
    //    a phone. Must precede the emphasis pass, which uses U+0001/U+0002 as sentinels.
    t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    t = t.replace(/[​-‍﻿]/g, '');

    // 5. Markdown emphasis.
    t = this.repairEmphasis(t);

    // 6. Tidy up after the removals: orphaned punctuation, doubled spaces, blank lines.
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/ *\n */g, '\n');
    t = t.replace(/\s+([,.!?;:])/g, '$1');
    t = t.replace(/([,;:])\s*(?=[,.!?;:])/g, '');
    t = t.replace(/\n{3,}/g, '\n\n');
    t = t.trim();

    // Nothing but punctuation left means the reply WAS the leak. Say so upstream.
    if (!t || /^[\s\p{P}\p{S}]+$/u.test(t)) return '';
    return t;
  }

  /**
   * WhatsApp renders *bold* and _italic_ only when the marker sits at a word boundary.
   * An asterisk wedged between two letters is therefore never formatting — it is token
   * corruption, and the phone prints it literally ("kaanpida*ven*"). Remove those, then
   * keep only balanced single-line pairs so a half-emitted bold marker can't leak either.
   */
  repairEmphasis(text) {
    let t = String(text || '').replace(/(?<=[\p{L}\p{N}])\*(?=[\p{L}\p{N}])/gu, '');
    // Mark the survivors that really are a pair, drop every orphan, then restore.
    t = t.replace(/\*([^*\n]+)\*/g, '\u0001$1\u0002').replace(/\*/g, '');
    return t.replace(/\u0001/g, '*').replace(/\u0002/g, '*');
  }

  /**
   * "Here's what we stock — which one?", built from the catalogue.
   *
   * Three paths need exactly this reply and they must not drift apart: the deterministic
   * "which teams do you have?" answer, a 'broad' search that matched nothing because the
   * customer has not named a team yet, and the recovery when the model offers teams we do
   * not carry. Returns null when the cache is empty, so callers can fall through.
   */
  teamListReply(language, session = null, limit = 12) {
    const teams = woocommerceService.listTeams(limit);
    if (teams.length === 0) return null;
    const list = teams.map(t => `• ${t}`).join('\n');
    const full = language === 'tanglish'
      ? `Idhellaam ippo stock la iruku 👇\n\n${list}\n\nEnna team venum? Team peru sollunga, naan price-um size-um kaatturen! ⚽`
      : `Here's what we've got in stock right now 👇\n\n${list}\n\nWhich team would you like? Tell me the name and I'll show you prices and sizes! ⚽`;

    // Printing the identical twelve-line list twice in a row is exactly what a stuck bot
    // looks like — the same thing the follow-up cooldown was added to stop on 2026-09-19.
    // The customer can still see the first one, so point at it instead of repeating it.
    // Compared against the full generated string, so this can only ever match our own list.
    const lastAssistant = [...(session?.history || [])].reverse().find(m => m.role === 'assistant');
    if (lastAssistant && lastAssistant.content === full) {
      return language === 'tanglish'
        ? `Mela iruka list la irundhu oru team peru sollunga — example: "Real Madrid" — naan price-um size-um udane kaatturen! ⚽`
        : `Just pick one from the list above — for example "Real Madrid" — and I'll send you the prices and sizes right away! ⚽`;
    }
    return full;
  }

  /* ────────────────────────────────────────────────────────────────────────────
   * GUIDED BROWSE (added 2026-09-22)
   *
   * Every path the bot had assumed the customer could already name what they wanted. Someone
   * who has never seen this shop cannot: asked "which team?" they have nothing to answer
   * with, and the 2026-09-21 chat is four turns of exactly that standoff.
   *
   * So: show the kinds of product we stock → they pick one → show that kind's actual best
   * sellers → they pick a number and the normal size/quantity flow takes over. Two taps from
   * "I don't know" to a cart.
   *
   * Deterministic end to end, and not only to save the LLM calls: a customer being shown the
   * shape of the shop is precisely when an invented category or a team we do not carry does
   * the most damage, because they have no way to tell it is wrong.
   * ──────────────────────────────────────────────────────────────────────────── */

  /**
   * "Here is everything we stock" — the kinds of product, numbered, each with real examples.
   * Arms the session to read the customer's next message as a choice from THIS list.
   * Returns null when the cache is empty so the caller can fall through.
   */
  browseMenuReply(language, session) {
    const groups = woocommerceService.listCatalogueGroups();
    if (groups.length === 0) return null;

    // What the numbers in the message mean, so the next turn resolves them against the list
    // the customer actually saw rather than against whatever the catalogue looks like then.
    session.browseGroups = groups.map(g => ({ key: g.key, label: g.label }));
    session.pendingBrowse = true;
    // Nothing product-shaped was shown, so a reply of "1" is a CATEGORY, never a product.
    session.lastShownProducts = [];
    session.pendingProductIndex = null;

    const isTanglish = language === 'tanglish';
    const lines = groups.map((g, i) => {
      const eg = g.examples.length > 0 ? ` — ${g.examples.join(', ')}…` : '';
      return `${i + 1}. ${g.emoji} *${g.label}* (${g.count})${eg}`;
    }).join('\n');

    return isTanglish
      ? `Namma kitta idhellaam iruku 👇\n\n${lines}\n\nEdhu paarkanum? Number sollunga (1, 2, 3…) — andha category la adhigam vikkura top jerseys naan kaatturen! 🔥`
      : `Here's everything we stock 👇\n\n${lines}\n\nWhich one would you like to see? Just send the number (1, 2, 3…) and I'll show you the best sellers in it! 🔥`;
  }

  /**
   * The best sellers in one group, numbered and ready to order from.
   *
   * Sets `lastShownProducts`, which is what hands the customer straight into the existing
   * deterministic paths: "2" is parseProductSelection, "2 M 3" is parseSizeQtyReply. That is
   * the "then proceed" half — no new ordering code, and no LLM call anywhere in the journey.
   */
  bestSellersReply(groupKey, session, limit = 3) {
    const group = woocommerceService.listCatalogueGroups().find(g => g.key === groupKey);
    const top = woocommerceService.bestSellersInGroup(groupKey, limit);
    if (!group || top.length === 0) return null;
    // So "show me all of them" next turn knows which shelf "them" is.
    session.lastListContext = { type: 'group', key: groupKey };

    session.lastShownProducts = top.map(p => ({
      productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: p.permalink || '',
    }));
    session.pendingProductIndex = null;
    session.productListPending = true;
    session.pendingBrowse = false;

    const isTanglish = session.language === 'tanglish';
    const lines = top.map((p, i) => {
      const sizeText = p.sizes && p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : '';
      return `${i + 1}. *${p.name}* — ₹${p.price}${sizeText}${p.permalink ? `\n${p.permalink}` : ''}`;
    }).join('\n');

    if (limit > 3) {
      const range = top.length > 1 ? `1–${top.length}` : '1';
      return isTanglish
        ? `${group.emoji} *${group.label}* — stock la irukura ellaam 👇\n${lines}\n\nEdhu venum (${range})? Size, quantity-um sollunga 🛍️`
        : `${group.emoji} *${group.label}* — everything we have in stock 👇\n${lines}\n\nWhich one would you like (${range})? Tell me the size and quantity too 🛍️`;
    }
    return isTanglish
      ? `${group.emoji} *${group.label}* — idhula ippo adhigam vikkuradhu idhu dhaan bro! 🔥\n${lines}\n\nEthu venum — ${pickRange(top.length, true)}? Enna size, evlo quantity venum? 🛍️`
      : `${group.emoji} *${group.label}* — these are our best sellers right now! 🔥\n${lines}\n\nWhich one would you like — ${pickRange(top.length, false)}? What size and how many? 🛍️`;
  }

  /** Team and player read from a product name: "SPORTING CP 2001-2002 HOME - RONALDO RN". */
  _teamAndPlayer(name) {
    const n = String(name || '');
    const team = n.split(/\s(?=\d|home\b|away\b|third\b)/i)[0].replace(/\b(fc|cf)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const parts = n.split(/\s[-—–]\s/);
    const player = parts.length > 1
      ? parts[parts.length - 1].replace(/\b(rn|clr[-\w]*|5-slv|full sleeve|half sleeve|sublimation|\(.*?\))\b/gi, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    return { team, player: /^[a-z .']{3,30}$/i.test(player) ? player : '' };
  }

  /**
   * "Ithula inno enna variety iruku?" / "9 okay, athula vera type kaatunga" — more like THE
   * jersey they are looking at, not the shelf it came from. On 10/2 both got the same ten-item
   * club list again, then the category menu. Same team first, then the same player.
   */
  _moreLikeThisReply(session, base) {
    const isT = session.language === 'tanglish';
    const { team, player } = this._teamAndPlayer(base.name);
    const seen = new Set([String(base.productId)]);
    const pick = [];
    for (const q of [team, player].filter(Boolean)) {
      for (const p of woocommerceService.searchProductsDetailed(q).products) {
        if (pick.length >= 8 || seen.has(String(p.id))) continue;
        seen.add(String(p.id));
        pick.push(p);
      }
    }
    // "SPORTING CP" → "Sporting CP": short tokens (CP, FC, PSG, AC) stay upper case.
    const title = s => s.split(/\s+/).map(w => w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (pick.length === 0) {
      return isT
        ? `*${base.name}* maadhiri vera jersey ippo stock la illa 😕 Idhaye edukkalama? Enna size, evlo quantity venum? 🛍️`
        : `We don't have anything else like *${base.name}* in stock right now 😕 Would you like this one? What size and how many? 🛍️`;
    }
    session.lastShownProducts = pick.map(p => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: p.permalink || '' }));
    session.productListPending = true;
    session.pendingProductIndex = null;
    session.pendingBrowse = false;
    session.lastListContext = { type: 'search', query: team || player };
    const lines = pick.map((p, i) => `${i + 1}. *${p.name}* — ₹${p.price}${p.sizes?.length ? ` [${p.sizes.join(', ')}]` : ''}${p.permalink ? `\n${p.permalink}` : ''}`).join('\n');
    const about = [team && title(team), player && title(player)].filter(Boolean).join(' / ');
    return isT
      ? `${about} la vera options 👇\n${lines}\n\nEdhu venum (${pickRange(pick.length, true)})? Size, quantity-um sollunga 🛍️`
      : `More from ${about} 👇\n${lines}\n\nWhich one would you like (${pickRange(pick.length, false)})? Tell me the size and quantity too 🛍️`;
  }

  /** "9 la enna iruku?" — what is number 9: name, price, sizes, link; then size and qty. */
  _productDetailReply(session, p) {
    const isT = session.language === 'tanglish';
    this._lockProduct(session, p);
    const sizes = p.sizes?.length ? p.sizes.join(', ') : null;
    return isT
      ? `*${p.name}*\n💰 ₹${p.price}${sizes ? `\n📏 Sizes: ${sizes}` : ''}${p.permalink ? `\n${p.permalink}` : ''}\n\nIdhu venumna enna size, evlo quantity venum nu sollunga 🛍️`
      : `*${p.name}*\n💰 ₹${p.price}${sizes ? `\n📏 Sizes: ${sizes}` : ''}${p.permalink ? `\n${p.permalink}` : ''}\n\nWant this one? Tell me the size and how many 🛍️`;
  }

  /** The numbered product a message points at ("9 la enna iruku?"), or null. */
  _pointedProduct(session, userQuery, v) {
    const shown = session.lastShownProducts || [];
    if (shown.length === 0) return null;
    const nums = (String(userQuery).match(/(?<![\d₹.])\d{1,2}(?![\d%])/g) || []).map(Number);
    const n = v?.pick || (nums.length === 1 ? nums[0] : null);
    return n && n >= 1 && n <= shown.length ? shown[n - 1] : null;
  }

  /**
   * The customer has seen everything on the current shelf and asked for "more" / "other".
   * Asked for best sellers → the shop-wide best sellers they haven't seen; otherwise → the
   * category menu, led by one honest line that this shelf is all there is.
   */
  _somethingDifferentReply(session, userQuery, v, shelfQuery, shelfSize) {
    const isT = session.language === 'tanglish';
    const shelf = String(shelfQuery || '').replace(/\b(jerseys?|jersy|jersi|shirts?)\b/gi, '').trim();
    const shelfName = shelf ? shelf.replace(/\b\w/g, c => c.toUpperCase()) : '';
    const lead = shelfName && shelfSize > 0
      ? (isT ? `${shelfName} la ippo ${shelfSize === 1 ? 'indha oru jersey' : `indha ${shelfSize} jerseys`} mattum dhaan stock la iruku.`
             : `That's all we have in ${shelfName} right now (${shelfSize}).`)
      : '';

    if (/\b(best|top|popular|trending|most sold|hot)\b/i.test(`${userQuery} ${v.meaning || ''}`)) {
      const seen = new Set((session.lastShownProducts || []).map(p => p.productId));
      const top = woocommerceService.searchProductsDetailed('best selling jerseys').products
        .filter(p => !seen.has(p.id)).slice(0, 5);
      if (top.length > 0) {
        session.lastShownProducts = top.map(p => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: p.permalink || '' }));
        session.productListPending = true;
        session.pendingProductIndex = null;
        session.pendingBrowse = false;
        session.lastListContext = { type: 'search', query: 'best selling jerseys' };
        const lines = top.map((p, i) => `${i + 1}. *${p.name}* — ₹${p.price}${p.sizes?.length ? ` [${p.sizes.join(', ')}]` : ''}${p.permalink ? `\n${p.permalink}` : ''}`).join('\n');
        const range = top.length > 1 ? `1–${top.length}` : '1';
        const body = isT
          ? `Namma shop la adhigam vikkura jerseys 🔥\n${lines}\n\nEdhu venum (${range})? Size, quantity-um sollunga 🛍️`
          : `Our best-selling jerseys 🔥\n${lines}\n\nWhich one would you like (${range})? Tell me the size and quantity too 🛍️`;
        return { text: lead ? `${lead}\n${body}` : body, intent: 'understood_best_sellers', ids: top.map(p => p.id) };
      }
    }

    const menu = this.browseMenuReply(session.language, session);
    if (!menu) return null;
    session.lastListContext = null;
    return { text: lead ? `${lead}\n\n${menu}` : menu, intent: 'understood_browse', ids: [] };
  }

  // Said only when sanitizeOutgoing() found nothing worth sending. Deliberately asks the
  // customer to restate rather than guessing: we know the model's last output was broken,
  // so anything we invented on top of it would be a guess about a guess.
  brokenReplyFallback(language) {
    return language === 'tanglish'
      ? 'Sorry 🙏 adhu sariya varala. Enna jersey venum nu innoru vaati sollunga — team illa player peru sollunga, naan udane kaatturen!'
      : "Sorry about that! 🙏 Could you tell me again what you're looking for — the team or player name? I'll pull it up right away.";
  }

  /* ────────────────────────────────────────────────────────────────────────────
   * TANGLISH QUALITY
   *
   * The client's report on 2026-09-21 was "mistakes even in the language (tanglish)", and
   * the chat behind it shows what kind: not a wrong language, but invented Tamil word-forms
   * that mean nothing to a Tamil speaker — "Which team or player theekana jersey venum",
   * "Chuuda, endha team venum", "Oru team pechu sollu", "best options kaanpidaven".
   * Every one is a real Tamil-ish shape assembled out of nothing, which is what a model
   * does when it is sampling freely in a language it only half knows.
   *
   * Three defences, in order of how much they are worth:
   *   1. Do not let the model write free Tanglish when a template will do (already true for
   *      product listings — those replies in the screenshot were the good ones).
   *   2. Lower the sampling temperature for Tanglish (see callLLMWithRetry).
   *   3. Give it a closed phrasebook in the prompt and the rule "if you are not sure a Tamil
   *      word is real, use the English word" — a Tanglish speaker mixing in English reads
   *      completely normal; invented Tamil does not.
   * This detector is the backstop for the cases that still get through: it names the
   * specific broken forms seen in production so a regeneration can be asked for once, and
   * so test_tanglish.js fails if any of them ever reaches a reply again.
   * ──────────────────────────────────────────────────────────────────────────── */

  // Word-forms observed being invented by the model, with what a Chennai seller would
  // actually type. Only entries confirmed meaningless/wrong go in here — this list drives
  // a regeneration, so a false positive costs a real LLM call.
  tanglishBadForms() {
    return [
      { bad: /\btheekana\b/i,            note: 'not a word' },
      { bad: /\bchuuda\b/i,              note: 'not a word' },
      { bad: /\bkaanpida(?:ven|vaen|ven)\b/i, note: 'invented verb form; "kaatturen" is the real one' },
      { bad: /\bpechu\s+sollu\b/i,       note: 'meaningless here; "team peru sollunga"' },
      { bad: /\buthavuven\b/i,           note: 'Google-Translate Tamil, not spoken' },
      { bad: /\bungalukku\s+naan\b/i,    note: 'Google-Translate Tamil, not spoken' },
      { bad: /\bthangaludaya\b/i,        note: 'formal written Tamil, never used in chat' },
      { bad: /\bnandri\b/i,              note: 'written Tamil; a seller types "thanks bro"' },
      // From a 2026-09-29 complaint reply the client flagged as meaningless.
      { bad: /\bnaurom\b/i,              note: 'not a word' },
      { bad: /\bappo\s+pathi\b/i,        note: 'wrong word ("pathi" = about/half); just "check panren"' },
      { bad: /\b(?:look|check|fix|sort)\s+panni?tt?en\b/i, note: 'claims it is ALREADY done — promise instead: "check panren"' },
      { bad: /\bnu\s+(?:dhaan\s+)?n[ie]n[ae]i?kk?ire?nga\b/i, note: 'guesses what the customer thinks — say it plainly' },
      { bad: /\bnu\s+\w+\s+nu\s+\w+/i,   note: 'two "nu" clauses chained — too complicated to read; use two short sentences' },
      // 2026-09-29: "Unaku etha team jersey venumnaalum sollunga" — "unaku" is the informal
      // "you", rude to a customer; the prompt already says "neenga / unga / ungaluku".
      { bad: /\bunaku\b|\bunakku\b/i,    note: 'informal "you" — use "ungaluku"' },
    ];
  }

  /**
   * Problems with a Tanglish reply that are worth one regeneration. Returns [] for English
   * sessions — none of this applies there, and running it would be pure cost.
   */
  tanglishProblems(text, language) {
    if (language !== 'tanglish') return [];
    const t = String(text || '');
    if (!t.trim()) return [];
    const problems = [];
    // Tamil script in a reply that is contractually Roman-script Tanglish.
    if (/[஀-௿]/.test(t)) problems.push('Tamil script was used instead of Roman letters');
    for (const { bad, note } of this.tanglishBadForms()) {
      const hit = t.match(bad);
      if (hit) problems.push(`"${hit[0]}" is not real Tamil (${note})`);
    }
    return problems;
  }

  /**
   * Prices (₹…) and delivery days in a reply that appear nowhere the model could have read
   * them — not in the prompt, the owner's rules, a tool result or the conversation. Those are
   * invented, and a customer holds the shop to a quoted price. Totals are allowed: a known
   * price times a quantity up to 20, or two known amounts added together.
   */
  unsupportedFigures(reply, contextMessages = []) {
    const text = String(reply || '');
    const claimed = new Set();
    for (const m of text.matchAll(/(?:₹|\brs\.?|\binr)\s?(\d[\d,]*)/gi)) claimed.add(m[1].replace(/,/g, ''));
    for (const m of text.matchAll(/\b(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s*(?:working\s+)?(?:days?|naal|naatkal)\b/gi)) {
      claimed.add(m[1]);
      if (m[2]) claimed.add(m[2]);
    }
    if (!claimed.size) return [];
    const known = new Set();
    for (const m of contextMessages) {
      const body = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      for (const n of numbersIn(body)) known.add(n);
      if (m?.tool_calls) for (const n of numbersIn(JSON.stringify(m.tool_calls))) known.add(n);
    }
    const amounts = [...known].map(Number).filter(n => n >= 100 && n < 100000);
    const supported = (s) => {
      if (known.has(s)) return true;
      const n = Number(s);
      if (amounts.some(a => n % a === 0 && n / a <= 20)) return true;
      for (let i = 0; i < amounts.length; i++) for (let j = i; j < amounts.length; j++) if (amounts[i] + amounts[j] === n) return true;
      return false;
    };
    return [...claimed].filter(s => !supported(s));
  }

  /**
   * The built-in business facts, each tagged with the Rule Book topic it answers. They are the
   * whole STORE FACTS block for a store with no rule documents. Once the owner's documents
   * cover a topic, that topic's built-in line is dropped — never put a fact in both places: two
   * versions of one fact in the same prompt is how a model ends up quoting the stale one.
   */
  builtinFacts() {
    return [
      { topic: 'versions', text: `- Imported jerseys come in 4 versions:
  • FC Set — jersey + shorts, embroidered badges. ONLY the FC Set comes with shorts.
  • Master Version and Fan Version are the SAME version (two names for one product) — premium embroidery + premium fabric. Never describe a difference between them; "master version iruka?" and "fan version iruka?" are the same request.
  • Player Version — dry-fit fabric + heat-pressed logos and badges.
  • Retro Version — vintage-style jersey + premium embroidery + premium fabric.
- "Which version is best?" → it depends on the customer's preference; if they ask for OUR recommendation, it is Player Version.` },
      { topic: 'customisation', text: '- Player/own name on the back is NOT included by default. Name customisation costs ₹300 extra.' },
      { topic: 'delivery', text: '- Delivery: standard 5–7 working days; customised jerseys 8–10 working days. Never promise an exact date. Shipping is free.' },
      { topic: 'payment', text: '- Cash on Delivery is NOT available (see PAYMENT below).' },
      { topic: 'wholesale', text: `- Wholesale / bulk / reseller enquiries → reply with exactly: "For Wholesale Prices, Collections & Enquiries Contact: ${config.support.wholesaleNumber}". Never quote wholesale prices.` },
      { topic: 'giveaway', text: '- Giveaway → it was cancelled for now due to some issues and will be announced soon. Never invent dates, prizes, winners or reasons.' },
    ];
  }

  /**
   * The business-facts block of the system prompt. With owner rule documents in the Rule Book
   * (services/rules.js) the owner's "always" rules lead, the owner's topic rules arrive with
   * each message, and only the built-in facts for topics the documents do not cover remain.
   * Payment stays enforced by config regardless (see _paymentReply).
   */
  storeFactsBlock() {
    const header = 'STORE FACTS — approved by the owner. These are the ONLY answers to these topics; never contradict or embellish them:';
    const facts = (list) => list.map(f => f.text).join('\n');
    if (!rulesService.hasRules()) return `${header}\n${facts(this.builtinFacts())}`;
    const covered = rulesService.coveredTopics();
    const rest = this.builtinFacts().filter(f => !covered.has(f.topic));
    return rulesService.promptBlock(rest.length ? `Built-in store facts (for topics the owner's documents do not cover):\n${facts(rest)}` : '');
  }

  generateSystemPrompt(session) {
    const isTanglish = session.language === 'tanglish';

    // Worked examples are emitted for the SESSION'S LANGUAGE ONLY. session.language is
    // deterministically decided and locked before this runs, so a Tanglish session never
    // needs the English examples and vice-versa — sending both was ~41% of the prompt for
    // no benefit. Each language block below is self-contained (product search, multi-match
    // one-question rule, verbatim payment-link rule, an FAQ) so neither loses coverage.
    // ⚠️ DO NOT "improve" the tool-format guidance below by naming the bad output format.
    // Measured live against Groq llama-3.3-70b (2026-07-27, 20 calls per variant, temp 0.7,
    // production prompt + all 7 tools). tool_use_failed rate:
    //   95% — original prompt
    //   55% — after removing the line that literally spelled out "<function=name>...</function>"
    //   30% — after ALSO removing tool ARGUMENTS from the worked examples below
    // Both of those lines were added as guardrails against the model leaking tool calls as
    // text, and both made it dramatically WORSE: writing the forbidden token sequence into
    // the prompt primes the model to emit it (negation is weak; the pattern is strong), and
    // an example rendering `productId:45, name:"…", price:849, size:"L", qty:1` teaches that
    // arguments-as-text is a valid reply shape — which is very likely the source of the raw
    // JSON reply seen in the 2026-07-26 funnel test (identical field order).
    // Describe tool use ABSTRACTLY here. Never show the wire format, right or wrong.
    //
    // The same reasoning governs the MESSAGE FORMAT block below, added 2026-09-22 after a
    // customer was sent a raw escape fragment and a mid-word markdown marker: it says what a
    // customer-facing message IS, and never prints an example of the broken output it is
    // trying to prevent. The Tanglish banned-word list a few lines further down is the one
    // deliberate exception — those are ordinary vocabulary, not a token sequence the
    // constrained decoder can be primed into emitting, and naming them is the only way to
    // rule out those specific invented words. Even so, the real guarantee is not the prompt:
    // sanitizeOutgoing() removes leaks from every reply regardless of what the model does.
    // 30% is still far too high for Groq to be the primary provider — see the provider
    // ordering note in getFallbackEntries(). Re-measure before promoting Groq.
    const workedExamples = isTanglish
      ? `WORKED EXAMPLES — follow the STYLE and the RULES; every product, price and size must still come from a tool result:

[Tanglish] Team only — search straight away, never ask for a player first:
  Customer: "AC Milan jersey iruka bro?"
  → [Call the search_products tool]
  Tool returns products.
  → Reply: "Iruku bro! AC Milan la ippo irukkura options:
• AC MILAN HOME 25-26 — ₹799 [S, M, L, XL]
• AC MILAN AWAY 25-26 — ₹799 [M, L, XL]
Edhu pudichiruku, enna size venum?"
  (WRONG: "Konjam specific ah sollunga" — the team name was enough to search.)

[Tanglish] Picking a product → cart → address:
  Customer: "1st one L size 1"
  → [Call the update_cart tool]
  Tool returns success.
  → Reply: "Seri, cart la add panniten 🛒 Delivery ku unga name, full address, pincode, mobile number anuppunga."

[Tanglish] Multiple matches — top 2-3 only, ONE question at the very end:
  Customer: "messi jersey iruka?"
  → [Call the search_products tool]
  Tool returns 10 products.
  → Reply: "Messi jerseys iruku:
• FC BARCELONA 2009 FINAL HOME FULL SLEEVE — MESSI — ₹470 [S, M, L, XL]
• ARGENTINA 2026 WORLD CUP FULL SLEEVE EDITION — MESSI — ₹470 [S, M, L, XL]
Innum options website la iruku. Edhu venum, enna size?"

[Tanglish] Not in stock (tool says 'partial' or 'none') — say it plainly, then offer what IS there:
  Customer: "Real Madrid 26/27 player version venum"
  → [Call the search_products tool]
  Tool returns matchQuality "partial", unmatched ["26/27", "player version"].
  → Reply: "Real Madrid 26/27 Player Version ippo stock la illa. Idhu ippo available:
• REAL MADRID HOME 25-26 — ₹799 [S, M, L, XL]
Idhu paakureengala?"

[Tanglish] Price feels high — no invented discount; explain value, offer a real cheaper option:
  Customer: "price konjam kammi pannunga"
  → Reply: "Sorry, price fixed dhaan — discount ippo illa. Aana shipping free. Budget ah venumna vera version la cheap ah iruka nu search panni kaattava?"

[Tanglish] Undecided customer — suggest real best sellers, don't lecture:
  Customer: "enna vaanganum nu theriyala"
  → [Call the search_products tool with "best selling jersey"]
  Tool returns products.
  → Reply: "No problem! Namma customers adhigam vaangura jerseys idhu:
• PORTUGAL HOME 2026 — RONALDO — ₹799 [S, M, L, XL]
• ARGENTINA HOME 2026 — MESSI — ₹799 [M, L, XL]
Endha team ungaluku pidikkum?"

[Tanglish] Version question — only the STORE FACTS, simple words:
  Customer: "master version um fan version um enna difference?"
  → Reply: "Rendum ore version dhaan — Master nu sonnaalum Fan nu sonnaalum same product. Premium embroidery + premium fabric. Endha team la venum?"

[Tanglish] Order confirmed — paste the checkout link exactly:
  Tool (confirm_order) returns: { paymentUrl: "https://theaurax.in/checkout/order-pay/123/?pay_for_order=true&key=wc_abc" }
  → Reply: "Order confirm aayiduchu 🎉 Idhu unga payment link:
https://theaurax.in/checkout/order-pay/123/?pay_for_order=true&key=wc_abc
Link open panni UPI / card / net banking la pay pannunga."
  (The URL is pasted exactly as given, on its own line — never reworded or dropped.)

[Tanglish] COD — we are PREPAID ONLY:
  Customer: "COD iruka?"
  → Reply directly (NO tool call needed): "Sorry, ippo COD illa — prepaid mattum dhaan. UPI, card, net banking la pay pannalaam, shipping free. Endha jersey venum?"

[Tanglish] Off-topic — one friendly line, then back to jerseys:
  Customer: "match yaar jeyippanga?"
  → Reply: "Adhu predict panna mudiyaadhu 😄 Aana unga team jersey ready ah iruku — endha team support pannureenga?"`
      : `WORKED EXAMPLES — Follow these exactly:

[English] Product search:
  Customer: "Do you have Chelsea jersey?"
  → [Call the search_products tool]  [ONLY use the tool, no text]
  Tool returns products.
  → Reply: "Yes! We have the *Chelsea Home 25/26 Jersey* at ₹849 🔵 Available in S/M/L/XL. Tap the link to see it: [url]. Which size would you like?"

[English] Product search — multiple matches (pick top 2-3, ONE question at the end, not after each):
  Customer: "Do you have Messi jerseys?"
  → [Call the search_products tool]
  Tool returns 10 products.
  → Reply: "Great choice! 🔥 Here are the top Messi jerseys:
• FC BARCELONA 2009 FINAL HOME FULL SLEEVE — MESSI — ₹470 [S, M, L, XL]
• ARGENTINA 2006 HOME — MESSI — ₹430 [S, M, L, XL]
• ARGENTINA 2026 WORLD CUP FULL SLEEVE EDITION — MESSI — ₹470 [S, M, L, XL]
These are the top matches — more options on our website. Which one would you like, and what size? 🤔"
  (WRONG — do NOT do this: repeating "Which size?" after every single bullet. Ask it exactly once, at the very end.)

[English] Order confirmed — paying the checkout link:
  Tool (confirm_order) returns: { paymentUrl: "https://theaurax.in/checkout/order-pay/123/?pay_for_order=true&key=wc_abc" }
  → Reply: "Order confirmed! 🎉 Here's your payment link:
https://theaurax.in/checkout/order-pay/123/?pay_for_order=true&key=wc_abc
Open the link, pay by UPI, card or net banking, and your order is placed!"
  (Note the URL is pasted exactly as given, on its own line — never reworded or dropped.)

[English] FAQ query — payment (we are PREPAID ONLY, COD is NOT available):
  Customer: "Do you support cash on delivery?"
  → Reply directly (NO tool call needed): "Sorry, we don't offer Cash on Delivery — we're prepaid only. 🚚 You can pay by UPI, card or net banking, and shipping is FREE on every order!"`;

    // PROMPT-CACHING NOTE: everything above the "Current Session Context" line below is a
    // stable prefix (identical byte-for-byte across every call within a language), so the
    // OpenAI-compatible providers (Groq, Fireworks, Sarvam) auto-cache it and bill it at a
    // discount. The ONLY per-call-varying content (cart, address) is deliberately placed
    // LAST — if it sat near the top (as it used to) it would break the cache prefix and
    // nothing after it could be cached. Keep dynamic session state at the very end.
    const locked = orderState.lockedProduct(session);
    const known = this._knownAddress(session);
    const missingAddr = orderState.missingAddressFields(known);
    const item = session.cart?.[0];
    const sessionContext = `---
Current Session Context (this is the ONLY part that changes per turn):
ORDER STATE (authoritative — code-maintained, do not contradict):
- Current step: ${orderState.computeStep(session)}
- Selected product: ${locked ? `${locked.name} (id ${locked.productId}) — ₹${locked.price}` : 'none yet'}
- Size: ${item?.size || session.pendingSize || 'not given yet'}
- Quantity: ${item?.qty || session.pendingQty || 'not given yet'}
- Cart: ${JSON.stringify(session.cart || [])}
- Customer name: ${known.name || 'missing'} | Mobile: ${known.phone || 'missing'} | Pincode: ${known.pincode || 'missing'}
- Address: ${known.address || 'missing'}
- Shipping details still needed: ${missingAddr.length ? missingAddr.join(', ') : 'NONE — all on file, never ask again'}${session.lastOrder?.orderId && !locked ? `
- Order ALREADY PLACED in this chat: #${session.lastOrder.orderId}${session.lastOrder.checkoutUrl ? ` (payment link: ${session.lastOrder.checkoutUrl})` : ''} — never ask them to place it again` : ''}`;

    return `You are "Aura", the friendly AI assistant for "Theaurax.in" (a premium football jerseys retailer in India). You handle BOTH sales and after-sales customer support. If a customer asks your name or who they're talking to, tell them you're Aura from Theaurax.
Your goal is to be the smart, friendly shop person a customer trusts: understand what they actually want, answer it directly, and help them to a successful checkout — and to resolve support issues with genuine care.

---
${this.storeFactsBlock()}

HOW THE SHOP WORKS (always true, whatever the facts above say):
- You cannot add a custom name to an order yourself: collect the name they want, then call 'create_support_ticket' (issueType "other", description "Custom name: <name> on <product>") so the team adds it and its charge — and tell the customer the team will confirm it.
- Discounts, offers and coupon codes: none unless a tool result or the facts above show one. Prices are what the product listing says — never negotiate or promise a lower price.
- Anything not covered above or by a tool (stock, exact sizes, order status, policies) — never guess. Say the team will check it, and raise a ticket if needed.

HOW TO THINK BEFORE EVERY REPLY:
- Work out the customer's actual intent from their words AND the recent conversation. Typos and slang are normal ("barca jersy iruka" = Barcelona jersey enquiry; "milan" = AC Milan; "price enna" = what is the price).
- A team name alone is enough to search — never demand a player name, season or version first.
- "How much?", "that one", "available?", "full sleeve?", "no, the black one" refer to what was just discussed. Resolve them from context; ask ONE short question only if two or more products genuinely fit.
- Explain jersey terms (FC Set, Player Version, dry-fit, heat-pressed) in simple words — don't assume the customer knows them.
- End most replies with ONE short question that moves the sale forward (which team / which size / shall I add it). Never stack several questions.
- If the message is in a language that is neither English nor Tamil/Tanglish, don't guess: say sorry, you understand English and Tamil, and ask them to message in one of those.

---
COMMON FAQs — a code-level matcher already answers these instantly with zero LLM calls
whenever the customer is idle with an empty cart (shipping, payment, sizing, returns,
customization, bulk orders). If one of these topics comes up mid-flow (cart non-empty or
collecting address) and you need to answer it yourself, keep it brief and accurate — don't
invent policy details you're not sure of.
---

Tone & Style:
- Sound like a real person, never a robot: friendly and warm, casual when the customer is casual, calm and professional for payment problems, complaints and order issues.
- Short and easy to scan on a phone: 1–3 short sentences, or a short list when comparing products. No paragraphs for simple questions.
- No forced slang and no fake excitement. At most one or two emojis in a message, and only where they help — none is fine.
- If a product search returns many items, ONLY show the top 2 or 3 most relevant jerseys.

Instructions:
1. ALWAYS use 'search_products' when asked about jerseys. Never guess prices or stock.
2. If products are found, provide exact name, price, sizes, and permalink, with one short line on why it's a good pick — genuine, not over the top.
3. When a user wants to buy, ask for size and quantity. Once BOTH are provided, use 'update_cart'.
4. After updating the cart, ask for their full shipping address (Name, Pincode, Mobile).
5. Once the address is provided, use 'set_shipping_address'. The order summary and total are shown to the customer automatically right after — you do NOT need to (and must not try to) write your own summary or total for this step.
6. Once the tool result confirms the cart is valid, use 'confirm_order'. If the tool says it's a Bulk Order, follow the tool's instructions.
7. Emojis: optional, at most one or two per message, never one on every line.
8. IMPORTANT: When calling a tool, do NOT output conversational text before or after the tool call in the same message. Just use the tool.
9. BE SMART: If they reply with "M 3", interpret it as Size M, Quantity 3 for the last discussed product. ALWAYS use the exact productId when updating the cart.
10. CHECKOUT LINK: When confirm_order succeeds, the tool result will contain a paymentUrl. Paste that EXACT URL string verbatim, character-for-character, on its own line in your reply — never paraphrase it, shorten it, describe it ("I've sent your link"), or omit it. If the URL is missing from your reply, the customer cannot pay.
11. FORMATTING: When listing 2+ products, put each product on its own line (use a line break or bullet), never run them together in one sentence. Ask the size/quantity follow-up question ONCE, at the very end, after all products are listed — never repeat "which size?" after every single product. Keep replies in short, grammatically complete sentences — no sentence fragments or unrelated asides tacked onto the end of a reply.
12. NEVER call 'confirm_order' unless the customer's last message is PURELY a plain confirmation (yes/ok/confirm/seri, nothing else added). If they mention any change, correction, different item, different quantity, or a negation ("illa", "no", "wait", "change it") — do NOT confirm. Instead use 'update_cart' to fix the item first, then show the corrected summary and ask them to confirm again.

---
ORDER STATE IS AUTHORITATIVE (CRITICAL):
- The ORDER STATE block at the end of this prompt is maintained by code and is the single source of truth.
- Never invent or change the product, size, quantity, price, availability, address or payment information.
- Never replace the customer's selected product unless the customer explicitly asks for a different product in their latest message.
- Never ask for anything the ORDER STATE already has. If it says a detail is on file, use it.
- Short replies ("2", "M", "yes", "same", "already sent") are answers to YOUR last question — read them against the ORDER STATE.
- If the latest message is ambiguous, ask ONE short clarification question.
- Never restart product discovery or list teams while an order is in progress, unless the customer explicitly asks to browse or change the product.

---
PAYMENT — PREPAID ONLY (CRITICAL):
- Razorpay is the ONLY payment gateway enabled on theaurax.in. Cash on Delivery is DISABLED.
- NEVER offer, promise, or agree to Cash on Delivery, "pay on delivery", "cash la tharen",
  or any pay-later arrangement — not even if the customer insists or says they always pay
  that way. Accepting one means an order nobody can collect money for.
- The accepted methods are EXACTLY these, all through the payment link: ${(config.payment?.methods || []).join(', ') || 'the methods shown on the payment page'}.
  Never name any other payment method or app. Shipping is FREE on every order.
- If they ask for COD, say plainly that we're prepaid only, then move straight on to the
  payment link — apologise once, don't dwell on it.

---
NEVER INVENT PRODUCTS (CRITICAL — ZERO TOLERANCE):
- You may ONLY name, price, or link a product that appears in a 'search_products' tool result in THIS conversation. Every product name, price, size, and URL must come verbatim from a tool result.
- NEVER make up a product, a price, a size, or a theaurax.in/product/... link from your own knowledge (e.g. "PSG Home 2022", "CR7 Home 2022", "Manchester United 2023"). If it isn't in a tool result, it does not exist for you.
- To suggest ANY product — including when the customer says "any other options?", "vera ethuvum iruka?", "show me more" — you MUST call 'search_products' again first (for "any other", search the SAME team/player they were just asking about, e.g. still "ronaldo"), then reply ONLY with what the tool returns.
- If 'search_products' returns nothing, say so honestly and ask them to name a specific team or player — e.g. "Sorry, adhu ippo stock la illa. Vera enna team venum? Real Madrid, Barcelona, Chelsea?" — do NOT paper over it with invented items.
- The same rule applies to TEAMS, not just products. When you name teams to help the customer choose, name only teams this store actually carries — Real Madrid, FC Barcelona, AC Milan, Manchester United, Chelsea, Liverpool, Arsenal, Manchester City, Bayern Munich, Juventus, Germany, Argentina, Brazil, Portugal and the IPL sides. Never send someone off to ask for a club we do not stock.
- Kids jerseys are only offered when the customer explicitly asks for kids/child sizes. Never push a (KIDS) product to someone asking for a normal/adult jersey.
- SEARCH BEFORE YOU ASK. Never reply "could you be more specific?" / "which team?" to a jersey question before calling 'search_products' with the customer's own words. Search first, then ask a narrowing question only if the result is genuinely empty.
- The tool result tells you how good the match is. 'exact' means these really are what they asked for — hype them up. 'partial' means a detail could NOT be matched (the 'unmatched' list — e.g. a season or Player Version): say plainly and in ONE short sentence that it is unavailable, THEN show the alternatives. 'none' means we found nothing: say so honestly and ask which team or player they want. NEVER present a partial or no-match result as though it were what the customer asked for.
- A follow-up that only narrows ("player version", "26/27", "the 25-26 one") refers to the SAME team or player as the previous search. Keep the team in the query when you search again.

---
AFTER-SALES SUPPORT (you are ALSO the customer-support agent, not just sales):
Besides selling, you handle post-purchase help: order tracking, delivery delays, wrong/damaged/missing items, wrong customization, size exchanges, and general complaints. Switch naturally into support mode when the customer raises a problem — do not try to sell to someone with a complaint.

HOW TO HANDLE AN UPSET / COMPLAINING CUSTOMER (follow in order):
1. ACKNOWLEDGE FIRST. Open with genuine empathy BEFORE asking for anything — e.g. "I'm really sorry this happened, I understand how frustrating that is." Never lead with "Please share your order ID."
2. NEVER ARGUE. Even if the customer is rude, blaming, or swears — stay calm, never match their tone, never lecture, never tell them to calm down, never blame them.
3. BE SOLUTION-FOCUSED. Every reply moves toward a fix or a next step. Never dead-end with "that's our policy." Say "here's what we can do."
4. Then collect what's needed and act: for a specific order use the 'lookup_order' tool; for an issue the team must handle use 'create_support_ticket'.

ORDER TRACKING:
- To check an order, you MUST use the 'lookup_order' tool with the order number. NEVER invent or guess a status, delivery date, or tracking number.
- If the customer hasn't given an order number, ask for it warmly first.

COMPLAINT SCENARIOS (wrong item, damaged/defective, misprinted customization, missing/not-received package, delayed delivery):
- Apologise sincerely and acknowledge the inconvenience first.
- Ask for the order ID, and for a PHOTO when it's a wrong/damaged/misprinted item ("Please share a photo of the item you received").
- For a "marked delivered but not received" case, also gently ask them to check with neighbours/security/nearby before escalating.
- Then call 'create_support_ticket' with their name, order ID, issue type, and a short description so the human team takes over. Reassure them the team will follow up.

RETURNS / EXCHANGES / REFUNDS (the team decides each case — do NOT state or invent a policy):
- Never promise a refund, an exchange window, a replacement or any condition (days, tags, "unused"). The team checks every request personally.
- Collect the order ID, the reason, and a photo if the item is damaged/wrong, then call 'create_support_ticket' (issueType "exchange", or the matching complaint type) and tell the customer the team will get back to them here. They can also email ${config.support.email}.

CANCELLATION: Ask for the order number and raise a ticket quickly — if it hasn't been packed or shipped the team will try to cancel it. Don't promise that it will be cancelled.

CONTACT / ESCALATION:
- Support email: ${config.support.email}
- WHOLESALE / BULK enquiries: "For Wholesale Prices, Collections & Enquiries Contact: ${config.support.wholesaleNumber}".
- If the customer asks to talk to a real person, reassure them and call 'create_support_ticket' (issueType "talk_to_human") after collecting name + order ID + issue.

ABUSE HANDLING: If the customer becomes threatening, hatefully abusive, or harassing (not just frustrated/swearing about the problem — keep helping those), warn ONCE politely that you can't continue if it continues and offer to connect them to the team, then disengage if it persists.

OUT OF SCOPE — politely decline and redirect to jersey/order help: legal, medical or financial advice, competitor recommendations, politics, internal business info, and any promise you can't back (delivery dates you don't know, refunds, discounts not offered).

---
LANGUAGE RULE (CRITICAL — ALREADY DECIDED, DO NOT RE-DETECT):
- This customer's language has been detected as: ${isTanglish ? 'TANGLISH' : 'ENGLISH'}.
${isTanglish
  ? '- Respond ONLY in natural Tanglish (Tamil-English code-mixed, Roman script) for this ENTIRE conversation — e.g. "AC Milan jerseys iruku, options kaatturen.", "Enna size venum?". Never switch to pure English.'
  : '- Respond in professional, friendly English for this ENTIRE conversation. No Tamil/Tanglish words.'}
- This was decided from the customer\'s own words, not your guess — never override it mid-conversation.
${isTanglish ? `
TANGLISH STYLE (text like a smart, polite young shop executive in Tamil Nadu chatting on WhatsApp):
- Script: Roman letters ONLY. Never a single Tamil-script character.
- The blend: English for the NOUNS and shop words — jersey, size, stock, price, delivery, payment link, version, quality, order, discount, shorts, name. Tamil for the VERBS and connectives — iruku, illa, venum, pannunga, sollunga, paarunga, kaatturen, anuppuren, aagum. Example: "Real Madrid jersey stock la iruku, size sollunga." Mostly-English with a few Tamil words is perfectly natural; the opposite, with invented Tamil, is not.
- Respect without sounding old: address the customer as "neenga / unga / ungaluku" and use polite "-unga" verbs (sollunga, paarunga, pannunga). Refer to the shop as "naanga / namma". Never use "nee / un", and never textbook Tamil.
- "bro": only if the customer uses it first, and at most once in a reply. Never "machan", "mame", "da", "dei".
- Crisp: 1–3 short sentences, straight to the answer, then ONE question that moves the order forward.
- SIMPLE: every sentence under about 10 words, with at most ONE Tamil verb in it. Never join clauses with "nu … nu". Never describe what the customer thinks or feels — one short "sorry" is enough.
- TENSE: promise what you WILL do — "check panren", "anuppuren", "team paapaanga". Never say you already did something ("panniten", "paathen", "anuppiten") unless a tool did it in this turn.

TANGLISH — THE ONE RULE THAT MATTERS MOST:
- If you are not 100% certain a Tamil word is REAL and SPELLED THE WAY TAMIL PEOPLE TYPE IT, use the plain English word instead. A Tamil speaker reading "Enna size venum?" thinks nothing of it. A Tamil speaker reading an invented word like "theekana" or "kaanpidaven" immediately knows they are talking to a machine.
- NEVER invent a Tamil-looking word by joining syllables together. Every Tamil word you type must be one you have actually seen used in a real Tamil WhatsApp chat.
- Mixing MORE English is always safe. Inventing Tamil is never safe.

TANGLISH WORDS YOU MAY USE (this is the safe list — prefer these, and use English for anything else):
- Asking: enna ("what"), edhu / endha ("which"), evlo ("how much / how many"), eppo ("when"), eppadi ("how"), venuma ("do you want")
- Having: iruku ("we have / it's there"), illa ("no / we don't have"), kedaikum ("is available"), stock la iruku, stock la illa
- Wanting: venum ("want"), vendaam ("don't want"), pudikkuma ("will you like it")
- Doing: pannunga ("please do"), sollunga ("please tell"), paarunga ("please look"), anuppunga ("please send"), kaatturen ("I'll show"), anuppuren ("I'll send"), check panren ("I'll check"), add panren ("I'll add"), potten ("I've added"), aayiduchu ("it's done"), aagum ("it will take / it becomes")
- Agreeing: seri ("ok"), kandippa ("definitely"), aamaa ("yes"), okay
- Reacting: super, semma ("great"), nalla iruku ("it's good"), sorry
- Problems: romba sorry ("very sorry"), order ID anuppunga ("please send the order ID"), photo anuppunga, team check pannuvaanga ("the team will check"), sort out panrom ("we will sort it out")
- Joiners: aana ("but"), appuram ("then"), ippo ("now"), konjam ("a little"), romba ("very"), kooda ("also"), dhaan ("only / just"), mattum ("only"), -na ("if": "venumna")

TANGLISH — STRICTLY NEVER DO THIS (these make you sound like a robot, not a human seller):
- NEVER use Tamil script. ALWAYS Roman letters.
- NEVER sound like Google Translate. WRONG: "Ungalukku naan eppadi uthavuven?" → RIGHT: "Enna jersey venum nu sollunga."
- NEVER write these — they are not Tamil words, they are machine noise: "theekana", "Chuuda", "pechu sollu", "kaanpidaven", "uthavuven", "thangaludaya".
- NEVER repeat the customer's full question back to them. Answer directly.
- NEVER start every reply with the same word ("Bro", "Kandippa", "Semma"). Vary it, or just answer.
- If the customer says they cannot understand you ("purila", "puriyala", "enna sollura", "what are you saying"), do NOT repeat yourself and do NOT add more Tamil. Apologise in one short line and say the SAME thing again in mostly plain English, with a concrete next step.` : ''}

MESSAGE FORMAT (CRITICAL — this text is sent to a phone exactly as you write it):
- Write ONLY the message the customer should read: ordinary sentences, product names, prices, sizes and links. If a part of your reply is not something a shop assistant would type to a customer, it does not belong in the message at all.
- Never include punctuation or symbols that belong to code or data rather than to a sentence. A customer messaging a jersey shop must not see one character of machine output.
- WhatsApp understands *bold* and _italic_ only. Open the marker immediately before the first letter of a complete word or product name and close it immediately after the last letter, and never leave one open. Anywhere else, use no formatting at all — a plain sentence always looks right.

TOOL FORMAT (CRITICAL — ZERO TOLERANCE):
- When calling a tool, that turn contains ONLY the tool call. No text before, no text after.
- Emit tool calls ONLY through the structured tool-call interface. Never write a tool call, its name, or its arguments into the message body in any form.
- After the tool returns a result, write your reply naturally based on the result.

${workedExamples}

${sessionContext}`;
  }

  getTools() {
    return [
      {
        type: "function",
        function: {
          name: "search_products",
          description: "Search the WooCommerce catalog for jerseys by team, player, or design.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "The search keyword." } },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "update_cart",
          description: "Add a jersey to the user's cart. Call this ONLY after confirming size and quantity with the user.",
          parameters: {
            type: "object",
            properties: {
              productId: { type: "number", description: "WooCommerce ID of the product." },
              name: { type: "string", description: "Product name." },
              price: { type: "number", description: "Product price." },
              size: { type: "string", description: "Requested size (e.g. S, M, L)." },
              qty: { type: "number", description: "Quantity." }
            },
            required: ["productId", "name", "price", "size", "qty"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "set_shipping_address",
          description: "Save the user's shipping address. Collect Name, Phone/Mobile, full Address, and Pincode before calling this.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Customer's full name." },
              // Plain "string" only — a JSON Schema type array like ["string","number"]
              // was tried to tolerate Qwen emitting bare numeric phone/pincode values,
              // but it broke Gemini's proto-based schema outright and is suspected of
              // degrading Groq's tool-call decoding reliability generally (a plain
              // Llama-3.3 query hit tool_use_failed on every one of 5 keys right after
              // this was introduced). Qwen is off by default now anyway, so the coercion
              // in the tool handler below (String(args.phone ?? '')) is enough on its own.
              phone: { type: "string", description: "Customer's 10-digit mobile number." },
              address: { type: "string", description: "Street/flat/area address." },
              pincode: { type: "string", description: "6-digit postal/PIN code." }
            },
            required: ["name", "phone", "address", "pincode"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "escalate_to_human",
          description: "Flag the conversation for human intervention if the customer wants a bulk/wholesale order (e.g. >= 10 items) or has a complex request.",
          parameters: {
            type: "object",
            properties: { 
              reason: { type: "string", description: "The reason for escalating to a human." },
              customerName: { type: "string", description: "The customer's name." },
              customerPhone: { type: "string", description: "The customer's phone number." },
              customerAddress: { type: "string", description: "The customer's full shipping address." }
            },
            required: ["reason", "customerName", "customerPhone", "customerAddress"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "confirm_order",
          description: "Finalize the order after the cart and shipping address are collected and the user has replied YES to confirm.",
          parameters: {
            type: "object",
            properties: {
              confirm: { type: "boolean", description: "Set to true to confirm." }
            },
            required: ["confirm"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "lookup_order",
          description: "Look up the status of an EXISTING customer order by its order number. Use this when a customer asks where their order is, its shipping/delivery status, or to check a specific past order. Requires the numeric order ID — if they haven't given one, ask for it first. Never guess an order status; always call this tool.",
          parameters: {
            type: "object",
            properties: {
              orderId: { type: "string", description: "The order number / order ID the customer provided (digits only)." }
            },
            required: ["orderId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_support_ticket",
          description: "Raise a support ticket for the human team when a customer has an after-sales issue you cannot resolve directly — wrong item, damaged/defective product, missing or not-received package, delayed delivery, wrong customization, a size exchange request, or an explicit request to talk to a person. Before calling, acknowledge their frustration, and collect their name plus the order ID and a short description of the problem (ask for a photo when the issue is a wrong/damaged/misprinted item).",
          parameters: {
            type: "object",
            properties: {
              customerName: { type: "string", description: "Customer's name." },
              orderId: { type: "string", description: "Order number if the customer has one, else empty string." },
              issueType: { type: "string", description: "One of: wrong_item, damaged, missing_package, delayed, wrong_customization, exchange, talk_to_human, other." },
              description: { type: "string", description: "Short summary of the customer's issue in plain words." },
              email: { type: "string", description: "Customer's email if they provided one, else empty string." }
            },
            required: ["customerName", "issueType", "description"]
          }
        }
      }
    ];
  }

  /**
   * Tell the model exactly what the search did and did not find.
   *
   * "Found products" was sent for every non-empty result, including the cheapest-five filler
   * returned on a zero-match search, so the model had no way of knowing it was about to
   * present unrelated shirts as answers.
   */
  _searchResultMessage(found, searchQuery) {
    if (found.matchQuality === 'exact') return 'Found products. These genuinely match what the customer asked for.';
    if (found.matchQuality === 'broad') {
      return 'NOT A MATCH — the customer has not named a team or player yet, so there is nothing to match on. '
        + 'Do NOT present any product as what they asked for and do NOT claim to have found something. '
        + 'Tell them what we stock and ask which team they want.';
    }
    if (found.matchQuality === 'partial') {
      return `PARTIAL MATCH. We do NOT have: ${found.unmatched.join(', ')}. `
        + `The products listed are the closest alternatives we DO stock. Say plainly and briefly that `
        + `${found.unmatched.join(' and ')} is unavailable, then offer these. Never imply they are what was asked for.`;
    }
    return `NO MATCH for "${searchQuery}". The products listed (if any) are generic popular suggestions, NOT matches. `
      + `Tell the customer honestly that you couldn't find it, ask which team or player they want, and you may offer `
      + `these as alternatives. Do NOT present them as the thing they asked for. Website: https://theaurax.in/?s=`
      + encodeURIComponent(searchQuery || '');
  }

  /**
   * Carry the subject of a search across turns.
   *
   * Tester review, 2026-09-20: "Real Madrid 26/27 all kit jerseys" followed by "Player version
   * 26/27" searched the second message verbatim. With the team gone there was nothing to match
   * on, so it fell through to the cheapest in-stock products and answered a Real Madrid
   * question with a CSK shirt. A follow-up that states only constraints means "the same thing
   * as before, but this way".
   */
  _mergeSearchContext(session, query) {
    const raw = (query || '').trim();
    const subject = woocommerceService.extractSubject(raw);
    if (subject) {
      // A new subject replaces the old one -- they have moved on to a different team.
      session.searchSubject = subject;
      return raw;
    }
    const hasConstraint = woocommerceService.parseSeasons(raw).present || Boolean(woocommerceService.parseVersion(raw));
    if (session.searchSubject && hasConstraint) {
      const merged = `${session.searchSubject} ${raw}`.trim();
      console.log(`[AI Service] Search context carried: "${raw}" -> "${merged}"`);
      return merged;
    }
    return raw;
  }

  sendEscalationAlert(senderId, userQuery, session) {
    const isSim = senderId.toString().includes('sim') || senderId.toString().includes('test');
    const channel = isSim ? 'Test Simulation' : 'Live Chat';
    
    const details = session.escalationDetails || {};
    const name = details.name || session.customerName || 'Unknown';
    const phone = details.phone || senderId.toString().replace(/[^0-9]/g, '');
    const address = details.address || session.address || 'Not provided';
    const reason = details.reason || 'Wholesale / Bulk Order';

    const mdAlertMsg = `🚨 *New Wholesale Lead Alert!* 🚨\n\n*Customer Details:*\n👤 Name: ${name}\n📱 Phone: ${phone}\n📍 Address: ${address}\n\n*Request Reason:*\n${reason}\n\n*Latest Message:*\n"${userQuery}"\n\nPlease step in to negotiate!`;

    const ownerNumber = config.owner?.whatsappNumber;
    if (ownerNumber && whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
      const cleanOwner = ownerNumber.replace(/[^0-9]/g, '') + '@c.us';
      whatsappWebBot.sendText(cleanOwner, mdAlertMsg).catch(err => {
        console.error('[AI Service] Failed to send WhatsApp owner escalation alert:', err.message);
      });
    }
  }

  // Live owner notification for a NEW after-sales support ticket (separate from the
  // wholesale/bulk lead alert — different template, different intent).
  sendSupportTicketAlert(senderId, ticket, session) {
    const phone = ticket.phone || senderId.toString().replace(/[^0-9]/g, '');
    const md = `🎫 *New Support Ticket* — ${ticket.id}\n\n👤 Name: ${ticket.name}\n📱 Phone: ${phone}\n${ticket.email ? `✉️ Email: ${ticket.email}\n` : ''}🧾 Order ID: ${ticket.orderId || 'Not provided'}\n🏷️ Issue: ${ticket.issueType}\n📷 Photo received: ${ticket.hasPhoto ? 'Yes' : 'No'}\n\n*Details:*\n${ticket.description || '(none)'}\n\nPlease follow up with the customer.`;

    const ownerNumber = config.owner?.whatsappNumber;
    if (ownerNumber && whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
      const cleanOwner = ownerNumber.replace(/[^0-9]/g, '') + '@c.us';
      whatsappWebBot.sendText(cleanOwner, md).catch(err => {
        console.error('[AI Service] Failed to send WhatsApp support ticket alert:', err.message);
      });
    }
  }

  parseGroqWaitMs(message) {
    const match = (message || '').match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
    if (!match) return 5 * 60 * 1000; // default 5 min if we can't parse it
    const minutes = parseInt(match[1] || '0', 10);
    const seconds = parseFloat(match[2] || '0');
    return Math.ceil((minutes * 60 + seconds) * 1000);
  }

  trimMessagesToTokenBudget(messages, budgetChars = 20000) {
    // Keep system prompt always; drop oldest context messages if over budget
    const systemMsg = messages[0];
    const rest = messages.slice(1);
    let totalChars = JSON.stringify(systemMsg).length;
    const kept = [];

    let i = rest.length - 1;
    while (i >= 0) {
      // A 'tool' result message is only valid immediately after the assistant message
      // that issued its tool_calls — dropping one while keeping the other produces an
      // invalid sequence the API rejects outright. Walk back over the whole consecutive
      // run of 'tool' messages plus their originating assistant turn and treat it as one
      // atomic, all-or-nothing group.
      let groupStart = i;
      if (rest[i].role === 'tool') {
        while (groupStart > 0 && rest[groupStart - 1].role === 'tool') groupStart--;
        if (groupStart > 0 && rest[groupStart - 1].role === 'assistant' && rest[groupStart - 1].tool_calls) {
          groupStart--;
        }
      }
      const group = rest.slice(groupStart, i + 1);
      const groupChars = group.reduce((sum, m) => sum + JSON.stringify(m).length, 0);

      // Always keep at least the most recent group. A single search_products tool
      // result (full product JSON — descriptions, images) can easily run 3-5K chars on
      // its own; breaking on the very first oversized message dropped it AND every older
      // message including the user's actual question, leaving only the bare system
      // prompt. Some models (Qwen) correctly reject that outright ("no user query found");
      // others (Llama) silently improvised a generic answer with zero real context.
      if (totalChars + groupChars > budgetChars && kept.length > 0) break;
      totalChars += groupChars;
      kept.unshift(...group);
      i = groupStart - 1;
    }
    return [systemMsg, ...kept];
  }

  async callLLMWithRetry(messages, client, provider = 'groq', keyIndex = 0, language = 'english', opts = {}) {
    const MAX_ATTEMPTS = 4;

    const model = provider === 'openai'
      ? (config.openai?.model || 'gpt-4o-mini')
      : provider === 'openrouter'
      ? (config.openrouter?.model || 'meta-llama/llama-3.3-70b-instruct:free')
      : provider === 'fireworks'
      ? (config.fireworks?.model || 'accounts/fireworks/models/deepseek-v4p1-flash')
      : provider === 'sarvam'
      ? (config.sarvam?.model || 'sarvam-105b')
      : provider === 'groq' && language === 'tanglish' && config.groq?.tanglishModel
      ? config.groq.tanglishModel
      : (config.groq?.model || 'openai/gpt-oss-120b');

    // Qwen3 is a reasoning model — without this it leaks its full <think>...</think>
    // chain-of-thought into the reply content instead of just the final answer.
    const isQwenReasoning = provider === 'groq' && model.includes('qwen');

    // Fireworks' deepseek-v4-pro is also a reasoning model: it needs enough max_tokens
    // to finish its internal reasoning AND still emit the visible answer, or content
    // comes back empty/truncated (returns the answer cleanly in `content` on Fireworks,
    // so no reasoning_format flag is needed — verified in test_fireworks.js). No 8000 TPM
    // ceiling here (paid tier), so give it comfortable headroom.
    const isFireworks = provider === 'fireworks';

    // Sarvam's models are reasoning models (contrary to the vendor docs used when this was
    // first wired). By default they spend the max_tokens budget on an internal
    // chain-of-thought — returned in a separate `reasoning_content` field — which on the old
    // sarvam-30b consumed the ENTIRE budget and left the visible `content` null/truncated
    // (verified 2026-07-22: null at max_tokens 800 AND 1500). The `/no_think` control tag
    // suppresses that reasoning pass, so for Sarvam we append it to the system message
    // (below) and keep the normal 800 budget.
    //
    // Re-verified on sarvam-105b (2026-08-04, after sarvam-30b was retired — see config.js):
    // 105b no longer truncates without the tag, but `/no_think` is still clearly honoured and
    // still worth keeping — on this bot's real 12.5k-char prompt + a 6-product tool result:
    //   with    /no_think → 254 completion tokens, 315 chars reasoning, 3.7s
    //   without /no_think → 455 completion tokens, 1061 chars reasoning, 6.3s
    // (and at max_tokens 1500 it expands to fill it: 1072 tokens, 12.7s, same answer).
    // So the tag is ~45% fewer output tokens and ~2x faster for identical Tanglish quality.
    const isSarvam = provider === 'sarvam';

    // Qwen's free tier caps at 8000 TPM/key for prompt+max_tokens COMBINED — much
    // tighter than Llama's. A multi-turn conversation's accumulated history can alone
    // approach that ceiling, so give it a much smaller trim budget than other providers.
    let trimmed = this.trimMessagesToTokenBudget(messages, isQwenReasoning ? 9000 : 20000);

    // For Sarvam only, append the `/no_think` control tag to the system prompt so the model
    // returns its answer directly instead of exhausting max_tokens on reasoning (see note
    // above). Other providers' messages are left byte-identical so their cacheable prefix
    // is unaffected.
    // ...except on a HARD Tanglish turn (opts.think — several questions, a comparison, a
    // complaint, a mid-order change; see services/tanglish.js). English goes to a reasoning
    // model and is logical; Tanglish went to Sarvam with thinking off and was not. Thinking
    // on costs ~200 more output tokens (~₹0.003) and ~2.5s, so it is spent only where it counts.
    const sarvamThinks = isSarvam && opts.think === true;
    if (isSarvam && !sarvamThinks) {
      const sysIdx = trimmed.findIndex(m => m.role === 'system');
      if (sysIdx !== -1) {
        trimmed = trimmed.map((m, i) =>
          i === sysIdx ? { ...m, content: `${m.content} /no_think` } : m
        );
      }
    }

    // Dynamically size max_tokens to what's actually left under the 8000 TPM ceiling,
    // rather than a fixed guess — a fixed 2000 still overflowed once real conversation
    // history pushed the prompt itself past ~6000 tokens. ~3.5 chars/token is a
    // deliberately conservative (over-)estimate so we undershoot the cap, not hit it.
    const qwenMaxTokens = isQwenReasoning
      ? Math.max(600, Math.min(2000, 7500 - Math.ceil((JSON.stringify(trimmed).length + JSON.stringify(this.getTools()).length) / 3.5)))
      : 800;

    if (!client) {
      const err = new Error(`${provider} client not initialized`);
      err.providerUnavailable = true;
      throw err;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Apply rate-limit throttle before making the API call
        return await this.callWithThrottle(() => client.chat.completions.create({
          model,
          messages: trimmed,
          // opts.noTools: the understanding step (services/understand.js) wants a small JSON
          // verdict, not an action — sending the tool schema would only invite a tool call.
          ...(opts.noTools ? {} : { tools: this.getTools(), tool_choice: 'auto' }),
          // Qwen's hidden <think> reasoning draws from the same max_tokens budget as the
          // visible answer — 800 was tuned for non-reasoning Llama and left zero room for
          // an actual reply once reasoning ran long, silently truncating to empty content.
          // qwenMaxTokens is sized dynamically against the actual prompt for this call
          // (see above) so it can't itself tip the request over the 8000 TPM ceiling.
          max_tokens: opts.maxTokens || (isQwenReasoning ? qwenMaxTokens : (isFireworks || sarvamThinks) ? 1500 : 800),
          // Tanglish samples COLDER than English, and that is the single cheapest fix for
          // the 2026-09-21 language complaint. Romanised Tamil has no orthographic standard
          // for a model to anchor on, so at 0.7 it happily samples a plausible-looking
          // word-shape that no Tamil speaker has ever used — "theekana", "Chuuda",
          // "kaanpidaven" all came out of one four-message conversation. English at 0.7 has
          // no equivalent failure because the model actually knows which strings are words.
          // Nothing is lost by cooling it: the hype and the product formatting are produced
          // by deterministic templates (see "Deterministic Fast Paths"), so the LLM's free
          // text only needs to be correct, not inventive.
          temperature: typeof opts.temperature === 'number' ? opts.temperature
            : language === 'tanglish' ? (attempt <= 2 ? 0.3 : 0.15) : (attempt <= 2 ? 0.7 : 0.2),
          ...(isQwenReasoning ? { reasoning_format: 'hidden' } : {})
        }), provider, keyIndex);
      } catch (err) {
        // Daily token quota (TPD) exhaustion — not recoverable by retrying with backoff.
        // Groq reports the reset is minutes away, so signal the caller to schedule a retry.
        if (provider === 'groq') {
          const isDailyQuota = err?.error?.code === 'rate_limit_exceeded' && /per day|TPD/i.test(err?.error?.message || '');
          if (isDailyQuota) {
            const quotaErr = new Error('Groq daily token quota exhausted');
            quotaErr.isQuotaExhausted = true;
            quotaErr.waitMs = this.parseGroqWaitMs(err?.error?.message);
            throw quotaErr;
          }
        }

        const isRateLimit = err.status === 429 || err?.error?.type === 'rate_limit_exceeded' || err?.error?.code === 'rate_limit_exceeded';
        const isServerErr = err.status === 503 || err.status === 500;
        // Groq's constrained tool-calling decoder occasionally emits invalid function-call
        // JSON and rejects its own generation with a 400. This is a transient generation
        // glitch, not a real failure — retrying the SAME key/turn usually succeeds, whereas
        // failing over to a different provider/key wastes the accumulated conversation context.
        const isToolLeak = err?.error?.code === 'tool_use_failed';
        if ((isRateLimit || isServerErr || isToolLeak) && attempt < MAX_ATTEMPTS) {
          const errLabel = isRateLimit ? 'rate limited' : isToolLeak ? 'tool_use_failed' : 'server error';
          const delay = isRateLimit ? attempt * 4000 : isToolLeak ? attempt * 1000 : attempt * 3000;
          console.warn(`[AI Service] ${provider} ${errLabel} (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Call Gemini (Google) LLM and convert response to OpenAI-compatible format.
   * Gemini uses a different SDK & message format — this bridges the gap.
   * Has a simple 2-attempt retry loop for transient errors.
   */
  async callGemini(messages, geminiClient) {
    if (!geminiClient) {
      const err = new Error('Gemini client not initialized');
      err.providerUnavailable = true;
      throw err;
    }

    const trimmed = this.trimMessagesToTokenBudget(messages);

    // Build Gemini-format conversation ONCE (retries reuse the same built history)
    const { systemMsg, geminiHistory, lastUserMsg, geminiTools } = this._buildGeminiConversation(trimmed);

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const model = geminiClient.getGenerativeModel({
          model: config.gemini?.model || 'gemini-2.0-flash',
          systemInstruction: systemMsg || undefined,
        });

        const chat = model.startChat({
          history: geminiHistory,
          tools: geminiTools,
        });

        const userText = lastUserMsg?.content || '';
        const result = await chat.sendMessage([{ text: userText }]);
        const response = result.response;
        const candidate = response.candidates?.[0];

        if (!candidate) {
          return { choices: [{ message: { content: "Sorry, I couldn't process that.", role: 'assistant' } }] };
        }

        const parts = candidate.content?.parts || [];

        // Check for function calls in the response
        const functionCalls = parts.filter(p => p.functionCall);
        if (functionCalls.length > 0) {
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: functionCalls.map((fc, i) => ({
                  id: `gemini_${fc.functionCall.name}_${i}`,
                  type: 'function',
                  function: {
                    name: fc.functionCall.name,
                    arguments: JSON.stringify(fc.functionCall.args || {})
                  }
                }))
              }
            }],
            usage: {
              total_tokens: response.usageMetadata?.totalTokenCount || 0
            }
          };
        }

        // Text response
        const text = parts.map(p => p.text || '').join('').trim();
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: text || "Sorry, I couldn't process that."
            }
          }],
          usage: {
            total_tokens: response.usageMetadata?.totalTokenCount || 0
          }
        };
      } catch (err) {
        // A quota/429 error means this key's daily or per-minute allowance is spent —
        // retrying it 3x with a 3s backoff cannot succeed and just burns latency on
        // every message. Fail immediately and let the caller bench this key instead.
        const isQuota = err.status === 429 || err?.message?.includes('RATE_LIMIT') || /quota/i.test(err?.message || '');
        if (isQuota) {
          err.isQuotaExhausted = true;
          const retryMatch = (err.message || '').match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
          // Google's returned retryDelay reflects the per-minute window, not the daily
          // quota reset — a free-tier key stuck at limit:0 will 429 again immediately
          // after it. Bench for a longer fixed window so we stop hammering it.
          err.waitMs = retryMatch ? Math.max(15 * 60 * 1000, Math.ceil(parseFloat(retryMatch[1]) * 1000)) : 15 * 60 * 1000;
          throw err;
        }

        const isRetryable = err.status === 500 || err.status === 503;
        if (isRetryable && attempt < MAX_ATTEMPTS) {
          console.warn(`[AI Service] Gemini error (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Convert OpenAI-format messages to Gemini-format conversation history.
   * Extracted so both callGemini and potential future callers can reuse it.
   */
  _buildGeminiConversation(trimmed) {
    // Extract system instruction from the first message (Gemini passes it separately)
    const systemMsg = trimmed[0]?.role === 'system' ? trimmed[0].content : '';
    const chatMessages = trimmed.slice(systemMsg ? 1 : 0);

    // Last message is the current user query — it goes to sendMessage(), not history
    const lastUserMsg = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;
    const history = chatMessages.length > 1 ? chatMessages.slice(0, -1) : [];

    // Convert OpenAI-format history to Gemini-format contents
    const geminiHistory = [];
    for (const msg of history) {
      if (msg.role === 'user') {
        geminiHistory.push({ role: 'user', parts: [{ text: msg.content || '' }] });
      } else if (msg.role === 'assistant') {
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            try {
              parts.push({
                functionCall: {
                  name: tc.function.name,
                  args: JSON.parse(tc.function.arguments)
                }
              });
            } catch (e) {
              // skip malformed tool calls
            }
          }
        }
        geminiHistory.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        try {
          geminiHistory.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: msg.name,
                response: typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content
              }
            }]
          });
        } catch (e) {
          geminiHistory.push({ role: 'user', parts: [{ text: `Result for ${msg.name}: ${msg.content}` }] });
        }
      }
    }

    // Convert OpenAI-style tools to Gemini function_declarations.
    // Gemini's proto-based schema only accepts a single string per "type" — a JSON
    // Schema array like ["string", "number"] (used elsewhere to tolerate Qwen emitting
    // unquoted numeric phone/pincode values) makes Gemini reject the whole request
    // ("Proto field is not repeating, cannot start list"). Collapse to the first type.
    const openaiTools = this.getTools();
    const normalizePropsForGemini = (properties) => {
      const out = {};
      for (const [key, val] of Object.entries(properties || {})) {
        const rawType = Array.isArray(val.type) ? val.type[0] : val.type;
        out[key] = { ...val, type: (rawType || 'string').toUpperCase() };
      }
      return out;
    };
    const geminiTools = openaiTools.length > 0 ? [{
      functionDeclarations: openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: {
          type: t.function.parameters.type?.toUpperCase() || 'OBJECT',
          properties: normalizePropsForGemini(t.function.parameters.properties),
          required: t.function.parameters.required || []
        }
      }))
    }] : undefined;

    // Gemini requires the first turn in history to be role 'user'. Char-budget trimming
    // can leave a lone assistant/tool turn at the front if it cuts between a user message
    // and its reply — drop leading non-user turns so the history always starts clean.
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }

    return { systemMsg, geminiHistory, lastUserMsg, geminiTools };
  }

  /**
   * Call LLM with automatic fallback chain.
   * Default order: Groq → OpenAI → OpenRouter → Gemini (cheapest/fastest first).
   * For Tanglish/Tamil conversations, Gemini goes first instead — Llama-3.3 (Groq's
   * model) is noticeably weaker at natural Tamil-English code-mixing than Gemini,
   * and reliable Tanglish is a hard client requirement, worth the extra latency/cost.
   * If a provider is rate-limited or unavailable, transparently switches to the next.
   */
  /**
   * Stable per-conversation hash, used to pick a starting key. Same customer → same
   * number every turn; different customers spread evenly across the key list.
   */
  static affinityIndex(affinityKey, length) {
    let h = 0;
    const s = String(affinityKey);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % length;
  }

  /**
   * Build the ordered key list for one provider.
   *
   * Without any rotation, every request tries keyIndex 0 first and only reaches the
   * other keys on an actual error — under concurrent load all traffic piles onto key 0
   * (starving it fast) instead of spreading across the available keys.
   *
   * The starting key is chosen by hashing `affinityKey` (the customer's senderId)
   * rather than by a global round-robin cursor. Both spread load evenly across keys,
   * but ONLY affinity keeps one conversation on one key — and prompt caching is
   * per-key. Round-robin made consecutive turns of the SAME conversation alternate
   * keys, so each call hit a cold prefix: measured 15% cached across a 6-call
   * conversation, versus 83% when a single key served it. Since ~85% of every request
   * is the byte-identical system prompt + tool schema, and cached input bills at
   * ₹2.5/M instead of ₹4/M on Sarvam, that difference is real money.
   *
   * Falls back to the round-robin cursor when there's no affinity key (background
   * jobs, retry-queue replays), preserving the old spreading behaviour.
   */
  rotateEntries(name, clients, type, affinityKey = null) {
    const entries = clients.map((client, i) => ({ name, client, type, keyIndex: i }));
    if (entries.length <= 1) return entries;
    let cursor;
    if (affinityKey) {
      cursor = AIService.affinityIndex(affinityKey, entries.length);
    } else {
      cursor = AIService.roundRobinIndex[name] || 0;
      AIService.roundRobinIndex[name] = (cursor + 1) % entries.length;
    }
    return [...entries.slice(cursor), ...entries.slice(0, cursor)];
  }

  async callLLMWithFallback(messages, language = 'english', affinityKey = null, opts = {}) {
    // Build a flat list of all API clients across all providers for key rotation.
    // affinityKey (the senderId) pins one conversation to one key so the cached
    // prompt prefix actually gets reused — see rotateEntries.
    const entries = [];
    const groqEntries = this.rotateEntries('groq', this.groqClients, 'openai', affinityKey);
    const geminiEntries = this.rotateEntries('gemini', this.geminiClients, 'gemini', affinityKey);
    const openrouterEntries = this.rotateEntries('openrouter', this.openrouterClients, 'openai', affinityKey);
    const fireworksEntries = this.rotateEntries('fireworks', this.fireworksClients, 'openai', affinityKey);
    const sarvamEntries = this.rotateEntries('sarvam', this.sarvamClients, 'openai', affinityKey);

    if (language === 'tanglish') {
      // Sarvam (sarvam-105b) is purpose-trained on romanized/code-mixed Tamil — best
      // Tanglish quality and cheapest, so it's tried FIRST. Fireworks (deepseek-v4-pro)
      // is the paid backup below it (also strong at code-mixing), then Groq/Llama-3.3 as
      // the fast free backstop. Gemini's old Tanglish-first slot is dead (free tier
      // returns limit:0). If neither Sarvam nor Fireworks keys are set, this degrades
      // cleanly to Groq-first.
      entries.push(...sarvamEntries, ...fireworksEntries, ...groqEntries);
    } else {
      // English: Fireworks (deepseek-v4-pro) is primary, Sarvam second, Groq LAST as a
      // free backstop. Groq WAS primary, but its constrained tool-calling decoder rejects
      // THIS bot's prompt+7-tool schema with `tool_use_failed` at a 95% rate (measured
      // 2026-07-27, 20 calls, temp 0.7 — the bare model tool-calls fine, so it's the
      // prompt/schema combo, not quota). With Groq first every reply burned failed retries
      // for ~76s before falling through to Fireworks anyway.
      //
      // ROOT CAUSE FOUND 2026-07-27 (see the note above generateSystemPrompt's
      // workedExamples): two "guardrail" prompt lines were causing it. Fixing both took the
      // rate 95% → 30%. Better, but 30% is still far too high to be the primary provider,
      // so Groq stays last for now.
      //
      // ⚠️ Before promoting Groq back, note the free tier is limited per ORGANIZATION, not
      // per key — a live 429 on 2026-07-27 read "Rate limit reached ... in organization
      // org_…" while rotating across all 5 keys. If those 5 keys are on ONE Groq account
      // they share ~30 RPM total, and rotation buys no extra rate-limit headroom at all.
      // Verify that before counting on Groq for burst capacity.
      entries.push(...fireworksEntries, ...sarvamEntries, ...groqEntries);
    }

    entries.push(...this.rotateEntries('openai', this.openaiClients, 'openai'));
    entries.push(...openrouterEntries);
    // Gemini last-resort for both languages (kept for parity; currently limit:0 on free tier).
    entries.push(...geminiEntries);

    if (entries.length === 0) {
      throw new Error('All LLM providers failed — no API keys configured');
    }

    let lastError = null;
    let groqQuotaError = null;

    for (const entry of entries) {
      const keySuffix = entry.keyIndex > 0 ? `[${entry.keyIndex}]` : '';

      // --- Proactive quota skipping ---
      // If a provider was recently exhausted and hasn't had time to reset, skip it
      // to avoid wasting time on calls that will surely fail.
      const providerName = entry.name;
      const stats = this.providerStats[providerName];
      // Daily quota (TPD) is granted per API key, not per provider — a key-scoped map
      // (keyExhaustedUntil) ensures one exhausted key only benches itself, not its
      // siblings. Without this, one key running out blacked out ALL keys of that
      // provider for the whole reset window, wasting the other keys' untouched quota.
      const exhaustKey = `${providerName}#${entry.keyIndex}`;
      const exhaustedUntil = this.keyExhaustedUntil[exhaustKey];
      if (exhaustedUntil && Date.now() < exhaustedUntil) {
        const remaining = Math.round((exhaustedUntil - Date.now()) / 1000);
        console.log(`[AI Service] Skipping ${providerName}${keySuffix} — quota exhausted, waiting ~${remaining}s for reset`);
        continue;
      }

      console.log(`[AI Service] Trying ${entry.name}${keySuffix}...`);
      try {
        let result;
        if (entry.type === 'gemini') {
          result = await this.callWithThrottle(() => this.callGemini(messages, entry.client), entry.name, entry.keyIndex);
        } else {
          result = await this.callLLMWithRetry(messages, entry.client, entry.name, entry.keyIndex, language, opts);
        }

        // Update active provider tracking
        if (this.activeProvider !== entry.name || this.activeKeyIndex !== entry.keyIndex) {
          console.log(`[AI Service] Switched LLM provider: ${this.activeProvider}[${this.activeKeyIndex}] → ${entry.name}${keySuffix}`);
          this.activeProvider = entry.name;
          this.activeKeyIndex = entry.keyIndex;
        }

        // Per-call token accounting. OpenAI-compatible providers return prompt/completion
        // splits; `prompt_tokens_details.cached_tokens` (when present) tells us how much of
        // the input was served from the provider's prompt cache — the direct signal for how
        // well the cacheable-prefix restructuring (dynamic session context moved last) is
        // paying off. Logged per call so real production numbers replace the report's
        // 40k-token/conversation estimate before any volume commitment.
        const usage = result.usage || {};
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
        const tokensUsed = usage.total_tokens || (promptTokens + completionTokens) || 0;
        const modelUsed = entry.name === 'openai'
          ? (config.openai?.model || 'gpt-4o-mini')
          : entry.name === 'openrouter'
          ? (config.openrouter?.model || 'meta-llama/llama-3.3-70b-instruct:free')
          : entry.name === 'fireworks'
          ? (config.fireworks?.model || 'accounts/fireworks/models/deepseek-v4p1-flash')
          : entry.name === 'sarvam'
          ? (config.sarvam?.model || 'sarvam-105b')
          : entry.name === 'gemini'
          ? (config.gemini?.model || 'gemini-2.0-flash')
          : entry.name === 'groq' && language === 'tanglish' && config.groq?.tanglishModel
          ? config.groq.tanglishModel
          : (config.groq?.model || 'openai/gpt-oss-120b');

        // Update token statistics (running totals + input/output/cached splits per provider)
        if (this.providerStats[providerName]) {
          const ps = this.providerStats[providerName];
          ps.tokensUsed = (ps.tokensUsed || 0) + tokensUsed;
          ps.promptTokens = (ps.promptTokens || 0) + promptTokens;
          ps.completionTokens = (ps.completionTokens || 0) + completionTokens;
          ps.cachedTokens = (ps.cachedTokens || 0) + cachedTokens;
        }
        this.totalTokensUsed = (this.totalTokensUsed || 0) + tokensUsed;

        // Per-call token log — the single line to watch when tuning token usage.
        const cachedNote = cachedTokens > 0 ? ` cached=${cachedTokens} (${Math.round((cachedTokens / promptTokens) * 100)}% of input)` : '';
        console.log(`[Tokens] ${entry.name}${keySuffix} model=${modelUsed} lang=${language} in=${promptTokens} out=${completionTokens} total=${tokensUsed}${cachedNote}`);

        // Push a call record
        this.callRecords.push({
          timestamp: Date.now(),
          provider: entry.name,
          keyIndex: entry.keyIndex,
          success: true,
          tokens: tokensUsed,
          promptTokens,
          completionTokens,
          cachedTokens,
          language,
          model: modelUsed
        });
        if (this.callRecords.length > 500) {
          this.callRecords.shift();
        }

        // --- Success analytics ---
        if (this.providerStats[providerName]) {
          this.providerStats[providerName].success++;
        }
        this.totalCalls++;

        return result;
      } catch (err) {
        const modelUsed = entry.name === 'openai'
          ? (config.openai?.model || 'gpt-4o-mini')
          : entry.name === 'openrouter'
          ? (config.openrouter?.model || 'meta-llama/llama-3.3-70b-instruct:free')
          : entry.name === 'fireworks'
          ? (config.fireworks?.model || 'accounts/fireworks/models/deepseek-v4p1-flash')
          : entry.name === 'sarvam'
          ? (config.sarvam?.model || 'sarvam-105b')
          : entry.name === 'gemini'
          ? (config.gemini?.model || 'gemini-2.0-flash')
          : entry.name === 'groq' && language === 'tanglish' && config.groq?.tanglishModel
          ? config.groq.tanglishModel
          : (config.groq?.model || 'openai/gpt-oss-120b');

        this.callRecords.push({
          timestamp: Date.now(),
          provider: entry.name,
          keyIndex: entry.keyIndex,
          success: false,
          tokens: 0,
          model: modelUsed,
          error: err.message || 'Unknown error'
        });
        if (this.callRecords.length > 500) {
          this.callRecords.shift();
        }

        // --- Error analytics ---
        if (this.providerStats[providerName]) {
          this.providerStats[providerName].errors++;
          this.providerStats[providerName].lastErrorAt = Date.now();
          this.providerStats[providerName].lastErrorMsg = err.message?.slice(0, 200) || 'Unknown error';
        }
        this.totalErrors++;

        // Track Groq quota exhaustion separately so we can schedule a retry
        // if ALL providers AND all keys fail.
        if (entry.name === 'groq' && err.isQuotaExhausted) {
          groqQuotaError = err;
          // Bench only THIS key until its own reset time — siblings stay available.
          this.keyExhaustedUntil[exhaustKey] = Date.now() + (err.waitMs || 5 * 60 * 1000);
          this.providerStats.groq.quotaExhausted++;
          console.warn(`[AI Service] Groq${keySuffix} quota exhausted, trying next key/provider...`);
          continue;
        }
        // Same proactive-skip mechanism as Groq, but for Gemini: a free-tier key stuck
        // at limit:0 will 429 on every call, so bench it instead of retrying it fresh
        // on every single message (previously wasted ~6-9s of latency per message).
        if (entry.name === 'gemini' && err.isQuotaExhausted) {
          this.keyExhaustedUntil[exhaustKey] = Date.now() + (err.waitMs || 15 * 60 * 1000);
          if (this.providerStats.gemini) this.providerStats.gemini.quotaExhausted++;
          console.warn(`[AI Service] Gemini${keySuffix} quota exhausted, benching for ~${Math.round((err.waitMs || 900000) / 60000)}m, trying next provider...`);
          continue;
        }
        lastError = err;
        console.warn(`[AI Service] ${entry.name}${keySuffix} failed, trying next... Error: ${err.message}`);
      }
    }

    // All providers AND all keys failed.
    if (groqQuotaError) {
      console.warn('[AI Service] All providers/keys failed — scheduling retry from Groq quota-exhaustion error.');
      throw groqQuotaError;
    }

    throw lastError || new Error('All LLM providers failed');
  }

  /**
   * Get provider analytics stats (usage counters, error tracking, quota status).
   * Returns a snapshot of all provider activity since app start or last reset.
   */
  getProviderStats() {
    return {
      providers: { ...this.providerStats },
      totals: {
        calls: this.totalCalls,
        errors: this.totalErrors,
        tokens: this.totalTokensUsed || 0,
        uptimeMs: Date.now() - this.appStartTime,
      },
      active: {
        provider: this.activeProvider,
        keyIndex: this.activeKeyIndex,
      },
      apiKeys: {
        groq: this.groqClients.length,
        openai: this.openaiClients.length,
        openrouter: this.openrouterClients.length,
        fireworks: this.fireworksClients.length,
        sarvam: this.sarvamClients.length,
        gemini: this.geminiClients.length,
        total: this.groqClients.length + this.openaiClients.length + this.openrouterClients.length + this.fireworksClients.length + this.sarvamClients.length + this.geminiClients.length,
      },
      keyExhaustedUntil: { ...this.keyExhaustedUntil },
      recentCalls: (this.callRecords || []).slice(-50),
    };
  }

  /**
   * Reset all provider analytics counters to zero.
   */
  resetProviderStats() {
    for (const key of Object.keys(this.providerStats)) {
      this.providerStats[key] = { success: 0, errors: 0, quotaExhausted: 0, tokensUsed: 0, lastErrorAt: null, lastErrorMsg: null };
    }
    this.totalCalls = 0;
    this.totalErrors = 0;
    this.totalTokensUsed = 0;
    this.callRecords = [];
    this.appStartTime = Date.now();
    this.keyExhaustedUntil = {};
    console.log('[AI Service] Provider analytics stats reset.');
  }

  scheduleQuotaRetry(senderId, userQuery, customerName, customerPhone, waitMs) {
    const delay = waitMs + 20000; // 20s buffer past Groq's stated reset time
    const retryAt = Date.now() + delay;
    // When this message was parked. If the customer has said anything since, replaying it
    // later would answer an old message against a newer state (a stale "Barcelona" arriving
    // after they have already picked and sized a jersey) — see the stale_retry check.
    const queuedAt = Date.now();

    // Persist to database so the retry survives server restarts
    dbService.savePendingRetry(senderId, userQuery, customerName, customerPhone, retryAt).catch(() => {});

    console.log(`[AI Service] Scheduling persistent quota retry for ${senderId} in ${Math.round(delay / 1000)}s (retryAt: ${new Date(retryAt).toISOString()})`);

    // Also schedule an in-memory setTimeout for immediate execution when the time comes
    setTimeout(async () => {
      // Only skip cleanup when answerQuery itself re-scheduled this same entry
      // (fresh retryAt already persisted) — every other outcome must clear it,
      // otherwise a broken/stale entry replays forever on each restart.
      let shouldDelete = true;
      try {
        const retryResponse = await this.answerQuery(senderId, userQuery, customerName, customerPhone, { queuedAt });

        if (retryResponse.intent === 'quota_exhausted') {
          shouldDelete = false;
        } else if (retryResponse.intent === 'stale_retry') {
          console.log(`[AI Service] Dropped stale quota retry for ${senderId} — the conversation has moved on.`);
        } else if (whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
          try {
            await whatsappWebBot.sendText(senderId, retryResponse.replyText);
            console.log(`[AI Service] Sent delayed quota-retry reply to ${senderId}`);
          } catch (sendErr) {
            console.error(`[AI Service] Failed to send delayed quota-retry reply to ${senderId}:`, sendErr.message);
          }
        }
      } catch (err) {
        console.error('[AI Service] Quota retry failed:', err.message);
      } finally {
        if (shouldDelete) {
          dbService.deletePendingRetry(senderId, userQuery).catch(() => {});
        }
      }
    }, delay);
  }

  /**
   * Process any pending retries that are due (called on startup + periodically).
   * This ensures quota-exhausted queries are retried even after a server restart.
   */
  async processPendingRetries() {
    try {
      const dueRetries = await dbService.getDueRetries();
      if (dueRetries.length === 0) return;

      console.log(`[AI Service] Processing ${dueRetries.length} pending retries from persistent queue...`);

      for (const entry of dueRetries) {
        // Only skip cleanup when answerQuery itself re-scheduled this same entry
        // (fresh retryAt already persisted) — every other outcome must clear it,
        // otherwise a broken/stale entry replays forever on each restart.
        let shouldDelete = true;
        try {
          const retryResponse = await this.answerQuery(
            entry.senderId,
            entry.userQuery,
            entry.customerName,
            entry.customerPhone,
            { queuedAt: entry.createdAt ? Date.parse(entry.createdAt) : null }
          );

          if (retryResponse.intent === 'quota_exhausted') {
            shouldDelete = false;
          } else if (retryResponse.intent === 'stale_retry') {
            console.log(`[AI Service] Dropped stale persistent retry for ${entry.senderId} — the conversation has moved on.`);
          } else if (whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
            try {
              await whatsappWebBot.sendText(entry.senderId, retryResponse.replyText);
              console.log(`[AI Service] Persistent retry reply sent to ${entry.senderId}`);
            } catch (sendErr) {
              console.error(`[AI Service] Failed to send retry reply to ${entry.senderId}:`, sendErr.message);
            }
          }
        } catch (err) {
          console.error(`[AI Service] Persistent retry failed for ${entry.senderId}:`, err.message);
        } finally {
          if (shouldDelete) {
            await dbService.deletePendingRetry(entry.senderId, entry.userQuery).catch(() => {});
          }
        }
        // Stagger retries to avoid flooding the API
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error('[AI Service] processPendingRetries error:', err.message);
    }
  }

  /**
   * No-LLM Fallback: when all LLM providers are exhausted, search the local product cache
   * and return a helpful response with relevant products. Zero API calls, zero cost.
   * Falls back to a generic "busy" message if no products match.
   */
  _buildNoLLMFallback(userQuery, language = 'english') {
    const isTanglish = language === 'tanglish';
    try {
      // searchProducts returns ONLY genuine matches since 2026-09-21, so a miss falls through
      // to the generic "we're busy" message below rather than offering unrelated shirts under
      // "I found these for you" -- which is the same false-match problem in a quieter place.
      const products = woocommerceService.searchProducts(userQuery || '');
      if (products && products.length > 0) {
        const topProducts = products.slice(0, 3);
        const productList = topProducts.map(p =>
          `\u2022 *${p.name}* \u2014 \u20B9${p.price}${p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : ''}${p.permalink ? `\n  ${p.permalink}` : ''}`
        ).join('\n');
        return isTanglish
          ? `Bro! 🙏 Romba messages varudhu ippo \u2014 but ungalukku idhu kandupudichen, wait pannunga:\n\n${productList}\n\nSize & quantity sollunga, naan vandhudhan sort pannuren! 🚀`
          : `Hey! 🙏 We're getting tons of messages right now \u2014 but I found these for you while you wait:\n\n${productList}\n\nJust reply with what you'd like (size & quantity) and I'll process it as soon as I'm back! 🚀`;
      }
    } catch (err) {
      console.warn('[AI Service] No-LLM fallback search failed:', err.message);
    }
    return isTanglish
      ? "Bro! 🙏 Romba messages varudhu ippo - konjam neram kudunga, naan personal ah reply pannuren. Thanks for the patience!"
      : "Hey! 🙏 We're getting a lot of messages right now - give me just a few minutes and I'll personally get back to you with an answer. Thanks for your patience!";
  }

  /* ────────────────────────────────────────────────────────────────────────────
   * DETERMINISTIC ORDER-STATE LAYER (added 2026-09-22)
   *
   * The order facts — which product, size, quantity, and the customer's shipping details —
   * are held in structured session fields and changed ONLY by code reading the customer's
   * own words (orderState.extractEntities). The LLM never becomes the source of truth for
   * them: its update_cart / set_shipping_address calls are checked against this state, and
   * its free-text replies are validated against it before they are sent.
   *
   * Session fields:
   *   selectedProduct  { productId, name, price, sizes, permalink } — locked on explicit pick
   *   pendingSize / pendingQty — collected before the cart line exists
   *   cart[0]          the committed line (same product as selectedProduct)
   *   addressDraft     partial shipping details, merged message by message
   *   customerProfile  last complete shipping details, kept across orders ("same address")
   *   productListPending  a numbered list is on screen, so a bare "2" is a pick
   *   pendingClarify   { type:'product_change', query } — waiting for yes/no
   *   lastOrder        { orderId, checkoutUrl, at } — so "how pay?" after ordering works
   * ──────────────────────────────────────────────────────────────────────────── */

  /** The question the bot is currently waiting on — decides what a bare "2" or "M" means. */
  _awaiting(session) {
    if (session.productListPending && session.lastShownProducts?.length > 0) return 'product';
    if (session.cart?.length > 0) return session.state === 'CONFIRMING_ORDER' ? 'confirm' : 'address';
    if (session.selectedProduct) {
      if (!session.pendingSize && !session.pendingQty) return 'size_qty';
      if (!session.pendingSize) return 'size';
      return 'qty';
    }
    if (session.lastShownProducts?.length > 0) return 'product';
    return null;
  }

  _lockProduct(session, p) {
    session.selectedProduct = {
      productId: p.productId, name: p.name, price: p.price,
      sizes: p.sizes || [], permalink: p.permalink || '',
    };
    session.productListPending = false;
    session.pendingProductIndex = null;
    if (!(session.cart?.length > 0)) session.state = 'COLLECTING_SIZE';
  }

  /** Forget the product/cart (explicit change or restart). Shipping details are kept. */
  _clearOrderSelection(session) {
    session.cart = [];
    session.selectedProduct = null;
    session.pendingSize = null;
    session.pendingQty = null;
    session.pendingProductIndex = null;
    session.pendingClarify = null;
    session.productListPending = false;
    session.state = 'IDLE';
  }

  /*
   * Removing a cart can be undone for an hour (2026-10-01). "Ithu venaam" was meant for the
   * ADDRESS; the bot removed the jersey, and with nothing to put back every later "keep the
   * jersey, change only the address" landed on an empty cart and got the team list.
   */
  _rememberRemovedCart(session) {
    if (!session.cart?.length && !session.selectedProduct) return;
    session.removedCart = {
      cart: (session.cart || []).map(i => ({ ...i })),
      selectedProduct: session.selectedProduct ? { ...session.selectedProduct } : null,
      at: Date.now(),
    };
  }

  _recentlyRemovedCart(session) {
    const rc = session.removedCart;
    if (!rc || !(rc.cart?.length || rc.selectedProduct)) return null;
    return Date.now() - (rc.at || 0) < 60 * 60 * 1000 ? rc : null;
  }

  /** Put the removed cart back. True when there was something to restore. */
  _restoreRemovedCart(session) {
    const rc = this._recentlyRemovedCart(session);
    if (!rc) return false;
    session.cart = rc.cart.map(i => ({ ...i }));
    const first = session.cart[0];
    session.selectedProduct = rc.selectedProduct
      || (first ? { productId: first.productId, name: first.name, price: first.price, sizes: [], permalink: '' } : null);
    session.removedCart = null;
    session.state = session.cart.length === 0 ? 'IDLE'
      : orderState.isAddressComplete(session.addressDetails) ? 'CONFIRMING_ORDER' : 'COLLECTING_ADDRESS';
    return true;
  }

  /**
   * "Keep the jersey, give a new address": drop the old address and ask for the new one in the
   * same "Name, Address, Pincode, Mobile number" format as the first time. The cart stays.
   */
  _startAddressChange(session, lead = '') {
    const isT = session.language === 'tanglish';
    session.addressDetails = null;
    session.addressDraft = null;
    session.customerProfile = null;
    session.address = null;
    session.state = 'COLLECTING_ADDRESS';
    const item = session.cart[0];
    const head = lead || (isT
      ? `Seri 👍 *${item.name}* — ${item.size} size, ${item.qty} qty cart la apdiye iruku. Pazhaya address ah eduthutten.`
      : `Sure 👍 *${item.name}* — Size ${item.size}, Qty ${item.qty} stays in your cart. I've removed the old address.`);
    const ask = isT
      ? 'Pudhu shipping details anuppunga — Name, Address, Pincode, Mobile number. 📦'
      : 'Please send your new shipping details — Name, Address, Pincode, Mobile number. 📦';
    return `${head}\n${ask}`;
  }

  /**
   * The customer is angry, or frustrated twice running, and has nothing the code can act on:
   * stop guessing, open a ticket and get a person. Repeating another list at this point is
   * what turned the 2026-10-01 chat into "Loosu theliva thana solren".
   */
  async _handOffToHuman(senderId, session, userQuery, v) {
    const isT = session.language === 'tanglish';
    session.handoffAt = Date.now();
    session.requiresEscalation = true;
    let ticket = null;
    try {
      const cart = (session.cart || []).map(i => `${i.name} (size ${i.size}) x${i.qty}`).join('; ') || 'empty';
      const recent = (session.history || []).slice(-6)
        .map(m => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 160)}`)
        .join(' | ');
      ticket = await dbService.saveTicket({
        userId: senderId,
        name: session.customerName || 'Customer',
        phone: session.customerPhone || senderId.replace(/\D/g, ''),
        email: '',
        orderId: session.lastOrder?.orderId ? String(session.lastOrder.orderId) : '',
        issueType: 'bot_handoff',
        description: `Customer is upset with the bot — please take over this chat. They said: "${userQuery}". `
          + `Bot read it as: ${v.meaning || v.intent}. Cart: ${cart}. Recent chat: ${recent}`,
        hasPhoto: !!session.photoReceived,
      });
      session.lastTicketId = ticket.id;
      this.sendSupportTicketAlert(senderId, ticket, session);
    } catch (err) {
      console.error('[AI Service] Could not raise hand-off ticket:', err.message);
    }
    const ref = ticket ? ` (ref ${ticket.id})` : '';
    const text = isT
      ? `Romba sorry 🙏 Naan sariya purinjukala. Unga chat ah team kitta anuppitten${ref} — oru person seekiram ungalukku message pannuvaanga.`
      : `I'm really sorry 🙏 I didn't get that right. I've passed this chat to our team${ref} — a person will message you shortly.`;
    return this._replyAndSave(senderId, session, userQuery, text, 'understood_handoff');
  }

  /** Best known shipping details: this order's draft on top of the saved profile. */
  _knownAddress(session) {
    let d = orderState.mergeAddress(session.customerProfile || {}, {});
    if (session.addressDetails) d = orderState.mergeAddress(d, session.addressDetails);
    if (session.addressDraft) d = orderState.mergeAddress(d, session.addressDraft);
    // The WhatsApp display name is NOT a shipping name: on 10/2 "Saaraa🐾" went onto the order
    // summary and the bot said "Name save panniten" for a name nobody typed. Ask for it.
    // A corrupted saved address is asked for again, never reused (see isPlausibleAddress).
    if (d.address && !orderState.isPlausibleAddress(d.address)) d.address = '';
    return d;
  }

  _cartTotal(session) {
    return (session.cart || []).reduce((sum, i) => sum + (parseFloat(i.price) || 0) * (parseInt(i.qty, 10) || 0), 0);
  }

  _summaryReply(session, lead = '') {
    const isT = session.language === 'tanglish';
    const lines = session.cart.map(item =>
      `• *${item.name}* — ${item.size} size, ${item.qty} qty — ₹${(parseFloat(item.price) || 0) * (parseInt(item.qty, 10) || 0)}`
    ).join('\n');
    const d = session.addressDetails || {};
    const pinShown = d.pincode && String(d.address).replace(/\s/g, '').includes(String(d.pincode));
    const ship = d.address ? `\n📦 ${d.name}, ${d.address}${pinShown ? '' : `, ${d.pincode}`} | 📱 ${d.phone}` : '';
    const head = lead ? `${lead}\n` : '';
    return isT
      ? `${head}Unga order summary:\n${lines}\nTotal: ₹${this._cartTotal(session)}${ship}\n\nConfirm panna "YES" nu reply pannunga 🎉`
      : `${head}Here's your order summary:\n${lines}\nTotal: ₹${this._cartTotal(session)}${ship}\n\nReply "YES" to confirm! 🎉`;
  }

  _fieldLabel(field, isT) {
    const en = { name: 'Name', address: 'full address (door no, street, area, city)', pincode: 'Pincode', phone: 'Mobile number' };
    const ta = { name: 'Name', address: 'full address (door no, street, area, city)', pincode: 'Pincode', phone: 'Mobile number' };
    return (isT ? ta : en)[field] || field;
  }

  _askMissingAddress(session, missing, { acknowledgeAlready = false } = {}) {
    const isT = session.language === 'tanglish';
    const d = this._knownAddress(session);
    const have = ['name', 'address', 'pincode', 'phone'].filter(f => !missing.includes(f) && d[f]);
    const need = missing.map(f => this._fieldLabel(f, isT)).join(', ');
    if (have.length === 0) {
      return isT
        ? `Ippo shipping details anuppunga — Name, Address, Pincode, Mobile number. 📦`
        : `Now please share your shipping details — Name, Address, Pincode, Mobile number. 📦`;
    }
    const got = have.map(f => this._fieldLabel(f, isT).split(' (')[0]).join(', ');
    if (acknowledgeAlready) {
      return isT
        ? `Aamaa, neenga anuppinadhu kedaichiduchu 👍 (${got} save panniten). Innum ${need} mattum venum — adha mattum anuppunga.`
        : `Yes, I have what you sent 👍 (${got} saved). I just need your ${need} — please send only that.`;
    }
    return isT
      ? `Thanks 👍 ${got} save panniten. Innum ${need} mattum anuppunga.`
      : `Thanks 👍 I've saved your ${got}. I just need your ${need}.`;
  }

  /**
   * Shipping details are complete: store them, run the bulk check, move to the confirmation
   * step. Shared by the deterministic path and the set_shipping_address tool.
   * Returns { bulk: true, totalQty } or { bulk: false }.
   */
  _applyAddress(senderId, session, details) {
    const d = { name: details.name, phone: String(details.phone), address: details.address, pincode: String(details.pincode) };
    session.addressDetails = d;
    session.addressDraft = { ...d };
    session.customerProfile = { ...d };
    session.address = `${d.name}, ${d.address}, ${d.pincode} | Ph: ${d.phone}`;
    session.customerPhone = d.phone;
    if (d.name && d.name !== 'Customer') session.customerName = d.name;
    dbService.saveCustomer(senderId, d.name, d.phone).catch(() => {});

    const totalQty = session.cart.reduce((sum, item) => sum + parseInt(item.qty || 0, 10), 0);
    const bulkThreshold = config.owner?.bulkThreshold || 10;
    if (totalQty >= bulkThreshold) {
      session.requiresEscalation = true;
      session.state = 'IDLE';
      session.escalationDetails = {
        reason: `Bulk Order (${totalQty} items)`,
        name: d.name || session.customerName,
        phone: d.phone || senderId.replace(/[^0-9]/g, ''),
        address: session.address,
      };
      return { bulk: true, totalQty };
    }
    session.state = 'CONFIRMING_ORDER';
    return { bulk: false };
  }

  /** Commit selectedProduct + pending size/qty into the one-line cart. */
  _commitCart(session) {
    const p = session.selectedProduct;
    session.cart = [{
      productId: p.productId, name: p.name, price: p.price,
      size: session.pendingSize, qty: session.pendingQty,
    }];
    session.pendingSize = null;
    session.pendingQty = null;
    session.state = 'COLLECTING_ADDRESS';
  }

  /** What to say to move the customer on from wherever they are. Never restarts discovery. */
  _nextStepPrompt(session) {
    const isT = session.language === 'tanglish';
    if (session.cart?.length > 0) {
      if (session.state === 'CONFIRMING_ORDER' && orderState.isAddressComplete(session.addressDetails)) {
        return this._summaryReply(session);
      }
      const item = session.cart[0];
      const missing = orderState.missingAddressFields(this._knownAddress(session));
      const head = isT
        ? `Unga cart la *${item.name}* — ${item.size} size, ${item.qty} qty iruku 🛒`
        : `You have *${item.name}* — Size ${item.size}, Qty ${item.qty} in your cart 🛒`;
      return `${head}\n${this._askMissingAddress(session, missing)}`;
    }
    const p = session.selectedProduct;
    if (p) {
      const sizeText = p.sizes?.length ? ` [${p.sizes.join(', ')}]` : '';
      if (session.pendingSize && !session.pendingQty) {
        return isT ? `*${p.name}* — ${session.pendingSize} size. Evlo quantity venum bro?` : `*${p.name}* — Size ${session.pendingSize}. How many would you like?`;
      }
      if (!session.pendingSize && session.pendingQty) {
        return isT ? `*${p.name}*${sizeText} — ${session.pendingQty} qty. Enna size venum?` : `*${p.name}*${sizeText} — Qty ${session.pendingQty}. Which size would you like?`;
      }
      return isT ? `*${p.name}*${sizeText} — enna size, evlo quantity venum? 🛍️` : `*${p.name}*${sizeText} — what size, and how many would you like? 🛍️`;
    }
    if (session.lastOrder?.orderId && session.lastOrder.checkoutUrl) {
      return isT
        ? `Unga order #${session.lastOrder.orderId} ku payment link idhu:\n${session.lastOrder.checkoutUrl}`
        : `Here's the payment link for your order #${session.lastOrder.orderId}:\n${session.lastOrder.checkoutUrl}`;
    }
    return null;
  }

  /** Payment answer built ONLY from config.payment — the model never names a method. */
  _paymentReply(session) {
    const isT = session.language === 'tanglish';
    const pay = config.payment || { codEnabled: false, methods: [] };
    const methods = (pay.methods || []).join(', ');
    let text;
    if (pay.codEnabled) {
      text = isT
        ? `COD available bro 👍 Illana online la pay pannalaam${methods ? ` — ${methods}` : ''}.`
        : `Cash on Delivery is available 👍 You can also pay online${methods ? ` — ${methods}` : ''}.`;
    } else {
      text = isT
        ? `Sorry, ippo COD illa — prepaid mattum dhaan. 🙏 Order confirm pannadhum oru payment link anuppuven${methods ? `, adhula ${methods} la pay pannalaam` : ''}.`
        : `COD is not available — prepaid payment is required. 🙏 Once you confirm the order I'll send a secure payment link${methods ? ` where you can pay by ${methods}` : ''}.`;
    }
    const lo = session.lastOrder;
    if (!session.cart?.length && !session.selectedProduct && lo?.orderId && lo.checkoutUrl) {
      // The order already exists, so "once you confirm the order I'll send a link" (the
      // pre-order wording above) is wrong here — 2026-09-29 chat. Just give them the link.
      return isT
        ? `Unga order #${lo.orderId} place aayiduchu ✅ Payment mattum pending.\nIdhu payment link:\n${lo.checkoutUrl}${methods ? `\n${methods} la pay pannalaam.` : ''}`
        : `Your order #${lo.orderId} is placed ✅ Only the payment is pending.\nHere's your payment link:\n${lo.checkoutUrl}${methods ? `\nYou can pay by ${methods}.` : ''}`;
    }
    const next = this._nextStepPrompt(session);
    return next ? `${text}\n\n${next}` : text;
  }

  /** Did the customer's own message ask for `candidate` rather than the locked product? */
  _customerNamedProduct(userQuery, candidate, locked) {
    const generic = new Set(['home', 'away', 'third', 'full', 'half', 'sleeve', 'jersey', 'kit', 'edition', 'version', 'player', 'fan', 'world', 'cup', 'final', 'plain', 'kids', 'retro', 'special']);
    const toks = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !generic.has(w));
    const lockedToks = new Set(toks(locked?.name));
    const q = String(userQuery || '').toLowerCase();
    return toks(candidate?.name).some(w => !lockedToks.has(w) && q.includes(w));
  }

  /**
   * Reject an LLM reply that contradicts the authoritative state. Returns a list of
   * problems (empty = OK). Checked only on free-text LLM replies — templated replies are
   * built from the state and can't disagree with it.
   */
  _validateReplyAgainstState(text, session, { searchRan = false } = {}) {
    const problems = [];
    const t = String(text || '');
    const low = t.toLowerCase();
    const active = orderState.hasActiveOrder(session);
    const locked = orderState.lockedProduct(session);
    const item = session.cart?.[0] || null;

    if (active) {
      const teams = woocommerceService.listTeams(20);
      const namedTeams = teams.filter(tm => low.includes(tm.toLowerCase())).length;
      if (/idhellaam ippo stock la iruku|here's what we've got in stock|which team would you like|enna team venum/i.test(t) || namedTeams >= 4) {
        problems.push('restarted product discovery (team list) during an active order');
      }
    }
    if (orderState.isAddressComplete(this._knownAddress(session)) && item
        && /(address|pincode|pin code|mobile number|phone number|shipping details)/i.test(t)
        && /(\?|share|send|sollunga|anuppunga|kudunga|provide|please give|tell me)/i.test(t)
        && !/(change|update|different|vera)\s+(address|details)/i.test(t)) {
      problems.push('asked for shipping details that are already on file');
    }
    if ((item?.qty || session.pendingQty) && /(how many|evlo quantity|enna quantity|quantity venum|how much quantity)/i.test(t)) {
      problems.push('asked for the quantity again');
    }
    if (item) {
      for (const m of t.matchAll(/(?<![\d₹])(\d{1,2})\s*(?:qty|quantity|pcs|pieces)\b|\bqty[:\s]+(\d{1,2})\b/gi)) {
        const n = parseInt(m[1] || m[2], 10);
        if (n && n !== parseInt(item.qty, 10)) { problems.push(`quantity ${n} contradicts cart qty ${item.qty}`); break; }
      }
      for (const m of t.matchAll(/\b(xxxl|xxl|xl|s|m|l)\s*size\b|\bsize[:\s]+(xxxl|xxl|xl|s|m|l)\b/gi)) {
        const sz = (m[1] || m[2]).toUpperCase();
        if (sz !== String(item.size).toUpperCase()) { problems.push(`size ${sz} contradicts cart size ${item.size}`); break; }
      }
    }
    if (locked && !searchRan) {
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const lockedNorm = norm(locked.name);
      const replyNorm = norm(t);
      const pool = [...(session.lastShownProducts || []), ...(woocommerceService.getLocalProducts() || [])];
      const other = pool.find(p => {
        const n = norm(p.name);
        return n && n.length >= 12 && n !== lockedNorm && replyNorm.includes(n);
      });
      if (other) problems.push(`mentions a different product ("${other.name}") than the locked one`);
      if (item) {
        const unit = parseFloat(item.price) || 0;
        const total = this._cartTotal(session);
        for (const m of t.matchAll(/₹\s?(\d{2,6})/g)) {
          const v = parseInt(m[1], 10);
          if (v !== unit && v !== total) { problems.push(`price ₹${v} matches neither the unit price nor the total`); break; }
        }
      }
    }
    const codOn = config.payment?.codEnabled;
    if (!codOn) {
      for (const sentence of t.split(/[.!?\n]/)) {
        if (/\b(cod|cash on delivery)\b[^.]{0,25}\b(available|iruku|irukku|possible|accepted|ok)\b/i.test(sentence)
            && !/\b(not|no|illa|kidaiyathu|kidaiyaathu|isn'?t|don'?t|unavailable)\b/i.test(sentence)) {
          problems.push('offered Cash on Delivery, which is disabled');
          break;
        }
      }
    }
    return problems;
  }

  /**
   * The deterministic turn. Reads the customer's message against the current order state and
   * handles everything that is really a state change — product pick, size, quantity, address,
   * "already sent", payment question, product change — without asking the model. Returns:
   *   a reply object      → send it, turn over
   *   { rewriteQuery }    → state was changed; continue the normal pipeline with this text
   *   null                → nothing order-shaped here; the normal pipeline handles it
   */
  async _handleOrderStateTurn(senderId, session, userQuery, verdict = null) {
    if (!userQuery || !userQuery.trim()) return null;
    // Catch-up / retry preambles ("[This message has been waiting…]") are for the model.
    if (/^\s*\[/.test(userQuery)) return null;

    const isT = session.language === 'tanglish';
    const shown = session.lastShownProducts || [];
    const awaiting = this._awaiting(session);
    let locked = orderState.lockedProduct(session);
    const ents = orderState.extractEntities(userQuery, {
      shownCount: shown.length, awaiting, hasSelection: Boolean(locked),
    });

    // With a verdict from the understanding step, the MEANING decides which of the extracted
    // details count; the extractor only supplies the values. Without this, any free text in
    // the address step was an address ("I want Man City jersey" became the shipping address)
    // and "order place panniten" was "I already sent my address" (2026-09-29).
    if (verdict) {
      const it = verdict.intent;
      if (it !== 'give_address') {
        ents.looksLikeAddress = false;
        ents.addressAlreadyGiven = false;
      }
      ents.paymentQuery = false;       // answered by the router, from config
      ents.changeProduct = false;      // product_search is handled by the router
      ents.confirm = it === 'confirm_order';
      ents.deny = ['pause_order', 'cancel_cart', 'closing'].includes(it);
      if (it === 'pick_product' && ents.productIndex === null && verdict.pick) ents.productIndex = verdict.pick - 1;
      if (['pick_product', 'size_qty'].includes(it)) {
        if (!ents.size && verdict.size) { ents.size = verdict.size; ents.sizeConfident = true; }
        if (!ents.qty && verdict.qty) ents.qty = verdict.qty;
      } else {
        // A size- or number-looking token in a question or an address is not an order change.
        ents.size = null; ents.qty = null; ents.productIndex = null;
      }
    }

    const respond = async (text, intent, productIds = []) => {
      session.history.push({ role: 'user', content: userQuery });
      session.history.push({ role: 'assistant', content: text });
      session.orderStep = orderState.computeStep(session);
      await this._saveSession(senderId, session);
      if (orderState.hasActiveOrder(session)) {
        await dbService.saveLead({
          userId: senderId,
          name: session.customerName || 'Customer',
          phone: senderId.replace(/[^0-9]/g, ''),
          channel: 'whatsapp',
          cart: session.cart || [],
          address: session.address || null,
          requiresEscalation: session.requiresEscalation || false,
          status: 'active',
          conversation: session.history || [],
        });
      }
      return { replyText: text, intent, requiresEscalation: false, suggestedProductIds: productIds };
    };

    // 0. The answer to our own "do you want to change the product?" question.
    if (session.pendingClarify?.type === 'product_change') {
      const pending = session.pendingClarify;
      session.pendingClarify = null;
      if (ents.confirm || ents.changeProduct || /^\s*(change|maathu|mathu|maathunga|yes change)\b/i.test(userQuery)) {
        this._clearOrderSelection(session);
        return { rewriteQuery: pending.query };
      }
      if (ents.deny || /\b(continue|same|this one|idhe|ithe|adhe|keep|podhum)\b/i.test(userQuery)) {
        const lead = isT ? 'Seri, andha order ae continue pannalaam 👍' : 'No problem — let\'s continue with your order 👍';
        return respond(`${lead}\n${this._nextStepPrompt(session)}`, 'state_resume');
      }
      // Anything else: read it normally below.
    }

    // 1. An explicit request to change the product unlocks it — and only this does.
    if (ents.changeProduct && locked) {
      const was = locked.name;
      this._clearOrderSelection(session);
      if (woocommerceService.extractSubject(userQuery)) return { rewriteQuery: userQuery };
      return respond(isT
        ? `Seri bro 👍 *${was}* ah remove panniten. Vera enna jersey venum — team illa player peru sollunga!`
        : `Sure 👍 I've removed *${was}*. Which jersey would you like instead? Tell me the team or player.`,
      'state_change_product');
    }

    // 2. Payment questions are answered from config, whatever the step — never with a team list.
    if (ents.paymentQuery && !ents.looksLikeAddress && (locked || session.lastOrder?.orderId)) {
      return respond(this._paymentReply(session), 'state_payment');
    }

    // 3. Picking from the numbered list that is on screen.
    let picked = false;
    if (ents.productIndex !== null) {
      const p = shown[ents.productIndex];
      if (!p) {
        if (shown.length > 0 && awaiting === 'product') {
          return respond(isT
            ? `List la ${shown.length} options dhaan iruku — 1${shown.length > 1 ? ` to ${shown.length}` : ''} la ethu venum?`
            : `There are only ${shown.length} options in the list — which one would you like (1${shown.length > 1 ? `–${shown.length}` : ''})?`,
          'state_clarify_product');
        }
      } else if (!locked || String(p.productId) !== String(locked.productId)) {
        // An explicit pick from the presented options is the one other thing (besides
        // "change product") allowed to move the lock.
        if (session.cart?.length > 0) {
          const old = session.cart[0];
          session.cart = [];
          this._lockProduct(session, p);
          session.pendingSize = orderState.productHasSize(p, old.size) ? old.size : null;
          session.pendingQty = old.qty;
        } else {
          this._lockProduct(session, p);
        }
        picked = true;
        locked = orderState.lockedProduct(session);
      } else {
        session.productListPending = false;
        picked = true;
      }
    } else if (awaiting === 'product' && shown.length === 1 && (ents.size || ents.qty)
        && (!locked || String(shown[0].productId) !== String(locked.productId))) {
      // One product on screen, which they searched for themselves: size/qty is for THAT one.
      if (session.cart?.length > 0) session.cart = [];
      this._lockProduct(session, shown[0]);
      picked = true;
      locked = orderState.lockedProduct(session);
    } else if (awaiting === 'product' && shown.length > 1 && ents.size && ents.sizeConfident) {
      // A size with no product. NEVER default to #1 — that is exactly how the Guardiola
      // shirt ended up in a cart meant for the Messi one. Ask, and keep what they said.
      session.pendingSize = ents.size;
      if (ents.qty) session.pendingQty = ents.qty;
      return respond(isT
        ? `List la edhu venum — ${shown.map((_, i) => i + 1).join(', ')}? (${ents.size} size${ents.qty ? `, ${ents.qty} qty` : ''} note panniten 👍)`
        : `Which one from the list — ${shown.map((_, i) => i + 1).join(', ')}? (I've noted Size ${ents.size}${ents.qty ? `, Qty ${ents.qty}` : ''} 👍)`,
      'state_clarify_product');
    }

    if (!locked) return null;
    const target = session.cart?.[0] || null;
    const productIds = [locked.productId];

    // 4. Size and quantity — applied to the LOCKED product only.
    let changed = false;
    const sizeUsable = ents.size && (ents.sizeConfident || ['size', 'size_qty', 'qty'].includes(awaiting) || picked);
    if (sizeUsable) {
      if (!orderState.productHasSize(locked, ents.size)) {
        const avail = (locked.sizes || []).map(s => String(s).split('-')[0]).join(', ');
        return respond(isT
          ? `Sorry, *${locked.name}* ku ${ents.size} size illa 😕 ${avail ? `Available: ${avail}. ` : ''}Vera size sollunga.`
          : `Sorry, *${locked.name}* isn't available in ${ents.size} 😕 ${avail ? `Available sizes: ${avail}. ` : ''}Which size would you like?`,
        'state_size_unavailable', productIds);
      }
      if (target) target.size = ents.size; else session.pendingSize = ents.size;
      changed = true;
    }
    if (ents.qty) {
      if (target) target.qty = ents.qty; else session.pendingQty = ents.qty;
      changed = true;
    }

    if (!target) {
      // Still before the cart: commit once both are known, otherwise ask for what's missing.
      if (session.pendingSize && session.pendingQty) {
        this._commitCart(session);
        const item = session.cart[0];
        const known = this._knownAddress(session);
        const added = isT
          ? `Done! 🛒 *${item.name}* — ${item.size} size, ${item.qty} qty cart la potten!`
          : `Done! 🛒 Added *${item.name}* — Size ${item.size}, Qty ${item.qty} to your cart!`;
        if (orderState.isAddressComplete(known)) {
          // Already have their details — don't ask again, go straight to the summary.
          const res = this._applyAddress(senderId, session, known);
          if (res.bulk) return this._bulkReply(senderId, session, userQuery);
          const note = isT ? `${added}\nMunnadi kuduthha address ae use panren 👍` : `${added}\nI'll use the address you already gave me 👍`;
          return respond(this._summaryReply(session, note), 'deterministic_cart', productIds);
        }
        return respond(`${added} ${this._askMissingAddress(session, orderState.missingAddressFields(known))}`, 'deterministic_cart', productIds);
      }
      // "andha first one ku name podalama? messi nu" picks a product AND asks something. The
      // canned "what size?" answered only the pick and ignored the question (seen live
      // 2026-09-28). Keep the pick, and let the agent — which now has the product locked in its
      // prompt — answer the question too.
      const asksMore = /\b(name|custom\w*|print\w*|podalama|podanum|evlo|price|delivery|quality|shorts|version|original|discount)\b/i.test(userQuery);
      if (picked && !changed && asksMore) return null;
      if (picked || changed) return respond(this._nextStepPrompt(session), picked && !changed ? 'deterministic_selection' : 'state_update', productIds);
      // Locked product but nothing order-shaped in this message → normal pipeline (LLM),
      // which gets the locked state in its prompt and is validated against it.
      return null;
    }

    // ── From here the cart exists: ADDRESS_COLLECTION or CART_REVIEW. ──

    // 5. Shipping details, in any shape, merged with what we already hold.
    if (ents.looksLikeAddress && (awaiting === 'address' || awaiting === 'confirm' || ents.address.phone || ents.address.pincode)) {
      session.addressDraft = orderState.mergeAddress(this._knownAddress(session), ents.address);
      const missing = orderState.missingAddressFields(session.addressDraft);
      if (missing.length === 0) {
        const res = this._applyAddress(senderId, session, session.addressDraft);
        if (res.bulk) return this._bulkReply(senderId, session, userQuery);
        return respond(this._summaryReply(session, changed ? (isT ? 'Update panniten ✅' : 'Updated ✅') : ''), 'state_address', productIds);
      }
      return respond(this._askMissingAddress(session, missing), 'state_address_partial', productIds);
    }

    // 6. "Already send paniten" — use what we have; never ask for all of it again.
    if (ents.addressAlreadyGiven) {
      let known = this._knownAddress(session);
      // Recover from earlier messages too (covers details sent before this layer existed).
      for (const m of (session.history || []).filter(h => h.role === 'user')) {
        const parts = orderState.parseAddressParts(m.content);
        if (parts.phone || parts.pincode || parts.address) known = orderState.mergeAddress(parts, known);
      }
      session.addressDraft = known;
      const missing = orderState.missingAddressFields(known);
      if (missing.length === 0) {
        const res = this._applyAddress(senderId, session, known);
        if (res.bulk) return this._bulkReply(senderId, session, userQuery);
        const lead = isT ? 'Aamaa, unga address kedaichiduchu 👍' : 'Yes — got your address 👍';
        return respond(this._summaryReply(session, lead), 'state_address_recalled', productIds);
      }
      return respond(this._askMissingAddress(session, missing, { acknowledgeAlready: true }), 'state_address_partial', productIds);
    }

    // 7. Size/qty corrections on the committed cart.
    if (changed) {
      const lead = isT ? 'Update panniten ✅' : 'Updated ✅';
      if (session.state === 'CONFIRMING_ORDER' && orderState.isAddressComplete(session.addressDetails)) {
        return respond(this._summaryReply(session, lead), 'state_update', productIds);
      }
      return respond(`${lead}\n${this._nextStepPrompt(session)}`, 'state_update', productIds);
    }

    // 8. "yes" before we have an address: ask for exactly what's missing.
    if (ents.confirm && session.state !== 'CONFIRMING_ORDER') {
      const missing = orderState.missingAddressFields(this._knownAddress(session));
      if (missing.length > 0) return respond(this._askMissingAddress(session, missing), 'state_address_partial', productIds);
    }

    // 9. A bare team/player name mid-order is ambiguous — ask, never restart the flow.
    const shortMsg = userQuery.trim().split(/\s+/).length <= 4 && !userQuery.includes('?');
    if (shortMsg && !ents.confirm && woocommerceService.extractSubject(userQuery)) {
      session.pendingClarify = { type: 'product_change', query: userQuery };
      return respond(isT
        ? `Bro, unga cart la ippo *${target.name}* (${target.size}, ${target.qty} qty) iruku. Idha maathi vera "${userQuery.trim()}" jersey venuma? Maathanum na "YES", idhe continue panna "NO" nu reply pannunga.`
        : `You currently have *${target.name}* (Size ${target.size}, Qty ${target.qty}) in your cart. Do you want to change it to a different "${userQuery.trim()}" jersey? Reply YES to change, or NO to continue with this order.`,
      'state_clarify_change', productIds);
    }

    return null;
  }

  /** Bulk order: hand to the wholesale team, reset the order (mirrors the LLM path). */
  async _bulkReply(senderId, session, userQuery) {
    const isT = session.language === 'tanglish';
    const reply = isT
      ? `Bro, idhu bulk order (${session.cart.reduce((s, i) => s + parseInt(i.qty || 0, 10), 0)} pcs) 🙌 Namma wholesale team unga kitta seekiram contact pannuvaanga — ${config.support.wholesaleNumber}.`
      : `This is a bulk order (${session.cart.reduce((s, i) => s + parseInt(i.qty || 0, 10), 0)} pieces) 🙌 Our wholesale team will reach out to you shortly — or call ${config.support.wholesaleNumber}.`;
    this._markSideEffect(senderId);
    this.sendEscalationAlert(senderId, userQuery, session);
    session.cart = [];
    session.address = null;
    session.history = [];
    session.hasEscalated = false;
    session.requiresEscalation = false;
    this._clearOrderSelection(session);
    await this._saveSession(senderId, session);
    return { replyText: reply, intent: 'bulk_escalation', requiresEscalation: true, suggestedProductIds: [] };
  }

  /**
   * Resolve the AUTHORITATIVE product for an `update_cart` call. The LLM supplies a
   * (productId, name, price) triple but can desync them — most dangerously by carrying a
   * STALE productId from earlier conversation history while displaying the CORRECT name and
   * price. Because the customer-facing order summary is built from name+price but the real
   * WooCommerce order is built from productId (woocommerce.createOrder → line_items.product_id),
   * a mismatch silently orders and charges for a DIFFERENT product than the one shown.
   * (Observed live 2026-07-26: customer picked & was quoted CSK 2025 id=74297 ₹350, but the
   * created order was Barcelona Messi id=74379 ₹470 — the model reused a stale id from a prior
   * order in the same chat's history.)
   *
   * Fix: never trust the LLM's raw productId. Re-derive the product from a trusted source —
   * first the exact list shown to THIS customer (`lastShownProducts`), then the full product
   * cache — and return that product's real id+name+price so the summary, the order, and the
   * charge always agree. The NAME is trusted over the id because the model copies the name
   * verbatim from our own templated result list, whereas the id is what it hallucinates.
   * Returns null only when nothing matches (caller falls back to raw args with a warning).
   */
  resolveCartProduct(args, session) {
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const argId = args.productId != null ? String(args.productId) : null;
    const argName = norm(args.name);

    const shown = session.lastShownProducts || [];
    const cache = (woocommerceService.getLocalProducts() || [])
      .map(p => ({ productId: p.id, name: p.name, price: p.price }));
    const pools = [shown, cache]; // prefer the list actually shown to this customer

    // 1) Exact name match — strongest signal (name is copied verbatim from our template).
    for (const pool of pools) {
      const m = argName && pool.find(p => norm(p.name) === argName);
      if (m) return { productId: m.productId, name: m.name, price: m.price };
    }
    // 2) Exact productId match.
    for (const pool of pools) {
      const m = argId && pool.find(p => String(p.productId) === argId);
      if (m) return { productId: m.productId, name: m.name, price: m.price };
    }
    // 3) Fuzzy name (length-guarded to avoid short-string false positives).
    if (argName && argName.length >= 8) {
      for (const pool of pools) {
        const m = pool.find(p => { const n = norm(p.name); return n && (n.includes(argName) || argName.includes(n)); });
        if (m) return { productId: m.productId, name: m.name, price: m.price };
      }
    }
    return null;
  }

  /**
   * Shared order-creation logic used by both the deterministic confirmation bypass and
   * the confirm_order tool handler in the main LLM loop, so there's one place that
   * decides what counts as a valid, orderable cart.
   */
  async _confirmOrderNow(session, senderId) {
    if (!session.cart || session.cart.length === 0) return { ok: false };
    const invalidItem = session.cart.find(item =>
      !item.name || !item.price || isNaN(parseFloat(item.price)) || parseFloat(item.price) <= 0
    );
    if (invalidItem) return { ok: false };

    const addrDetails = session.addressDetails || {
      name: session.customerName || 'Customer',
      phone: session.customerPhone || senderId.replace(/\D/g, ''),
      address: session.address || '',
      pincode: ''
    };
    // Ordering is known to be down (boot/periodic health check) — don't walk the customer
    // into a dead end. Report it as a failure so the caller escalates to a human instead.
    if (woocommerceService.orderingAvailable === false) {
      console.warn(`[AI Service] Skipping createOrder for ${senderId} — WooCommerce ordering is flagged unavailable.`);
      return {
        ok: true,
        created: false,
        orderId: null,
        checkoutUrl: null,
        error: woocommerceService.orderingError || 'WooCommerce ordering unavailable',
      };
    }

    this._markSideEffect(senderId);
    const orderResult = await woocommerceService.createOrder(session.cart, addrDetails, session.customerName);
    // Remember orders created in this session so the customer can always track them later
    // without the billing-phone match (they entered a delivery number, we placed it here).
    if (orderResult.success && orderResult.orderId) {
      session.orderIds = session.orderIds || [];
      if (!session.orderIds.map(String).includes(String(orderResult.orderId))) {
        session.orderIds.push(String(orderResult.orderId));
      }
    }
    // `created` is the ONLY field a caller may read as "a real order exists". It requires an
    // actual WooCommerce order ID, not merely the absence of an exception. Until 2026-09-21
    // this returned a bare `ok: true` on failure too, and both callers took that for success.
    return {
      ok: true,
      created: Boolean(orderResult.success && orderResult.orderId),
      orderId: orderResult.success ? orderResult.orderId : null,
      checkoutUrl: orderResult.success ? orderResult.paymentUrl : null,
      error: orderResult.success ? null : (orderResult.error || 'WooCommerce did not return an order'),
    };
  }

  /**
   * The side-effects of a failed order, shared by the deterministic path (which then writes
   * its own reply) and the LLM path (where the model writes the reply from the tool result).
   * Keeps the cart, flags the session for escalation, opens a ticket and pings the owner.
   */
  async _recordOrderFailure(senderId, session, result) {
    console.error(`[AI Service] ORDER CREATION FAILED for ${senderId}: ${result.error || 'unknown error'} — cart preserved, owner alerted.`);

    // Cart, address and history are deliberately NOT cleared -- the order still has to happen.
    session.state = 'CONFIRMING_ORDER';
    session.requiresEscalation = true;
    session.lastOrderError = result.error || 'unknown error';

    let ticket = null;
    try {
      const cartLine = (session.cart || [])
        .map(i => `${i.name} (size ${i.size || 'n/a'}) x${i.qty}`)
        .join('; ');
      ticket = await dbService.saveTicket({
        userId: senderId,
        name: session.customerName || 'Customer',
        phone: session.customerPhone || senderId.replace(/\D/g, ''),
        email: '',
        orderId: '',
        issueType: 'order_failed',
        description: `Order creation FAILED at WhatsApp checkout. Reason: ${result.error || 'unknown'}. `
          + `Cart: ${cartLine}. Address: ${session.address || 'not provided'}. `
          + `The customer was NOT told the order succeeded -- place it manually and send them the payment link.`,
        hasPhoto: false,
      });
      session.lastTicketId = ticket.id;
    } catch (ticketErr) {
      console.error('[AI Service] Could not raise order-failure ticket:', ticketErr.message);
    }

    this.sendOrderFailureAlert(senderId, session, result, ticket);
    return ticket;
  }

  /**
   * WooCommerce refused to create the order.
   *
   * The one thing we must NOT do here is tell the customer it worked. That is exactly what
   * shipped on 2026-08-07 and ran unnoticed until 2026-09-21: both confirm paths sent
   * "Your order is confirmed!", wiped the cart and address, marked the lead 'completed', and
   * attached a proforma PDF in place of a payment link -- with no owner alert and no ticket.
   * The customer believed they had ordered, no order existed, and the cart was unrecoverable.
   *
   * So instead: keep the cart, stay in CONFIRMING_ORDER (a later "yes" retries it in one
   * word), say plainly that it did not go through, ping the owner, and open a support ticket
   * so it lands in a queue a human actually reads. No PDF -- a proforma invoice with no
   * payment link is what made the false confirmation look official.
   */
  async _handleOrderFailure(senderId, session, userQuery, result) {
    const isTanglish = session.language === 'tanglish';
    const ticket = await this._recordOrderFailure(senderId, session, result);

    const ref = ticket
      ? (isTanglish ? ` Reference: ${ticket.id}.` : ` Your reference is ${ticket.id}.`)
      : '';
    const reply = isTanglish
      ? `Sorry 🙏 order ippo place panna mudiyala — engaluku oru technical problem. Ungalukku ethuvum charge aagala, cart safe ah iruku.${ref} Namma team ku alert poyiduchu, seekiram unga kitta contact pannuvaanga. Konja neram kazhichu "yes" nu reply pannunga, naan marubadiyum try pannuren!`
      : `I'm really sorry — I couldn't place that order just now, there's a technical issue on our side. 🙏 You have NOT been charged and your cart is safe.${ref} Our team has been alerted and will contact you shortly to complete it. You can also reply "yes" in a few minutes and I'll try again.`;

    session.history.push({ role: 'user', content: userQuery });
    session.history.push({ role: 'assistant', content: reply });

    await this._saveSession(senderId, session);
    await dbService.saveLead({
      userId: senderId,
      name: session.customerName || 'Customer',
      phone: senderId.replace(/[^0-9]/g, ''),
      channel: 'whatsapp',
      cart: session.cart || [],
      address: session.address || null,
      requiresEscalation: true,
      status: 'active',
      conversation: session.history || [],
    });

    return { replyText: reply, intent: 'order_failed', requiresEscalation: true, suggestedProductIds: [] };
  }

  // Owner ping for a checkout that could not be completed. Separate from the wholesale-lead
  // and support-ticket alerts because the urgency is different: a customer is sitting there
  // having just been told their order did not go through, and the sale is still winnable.
  sendOrderFailureAlert(senderId, session, result, ticket) {
    const phone = session.customerPhone || senderId.toString().replace(/[^0-9]/g, '');
    const items = (session.cart || [])
      .map(i => `• ${i.name} — size ${i.size || 'n/a'} x ${i.qty} — ₹${i.price}`)
      .join('\n') || '(cart empty)';
    const md = `⚠️ *ORDER FAILED — action needed*\n\n`
      + `A customer confirmed an order and WooCommerce refused it. They have been told it did NOT go through.\n\n`
      + `👤 Name: ${session.customerName || 'Customer'}\n`
      + `📱 Phone: ${phone}\n`
      + (ticket ? `🎫 Ticket: ${ticket.id}\n` : '')
      + `\n*Cart:*\n${items}\n\n`
      + `*Address:*\n${session.address || 'Not provided'}\n\n`
      + `*Error:* ${result.error || 'unknown'}\n\n`
      + `Place this order manually and send them the payment link.`;

    const ownerNumber = config.owner?.whatsappNumber;
    if (ownerNumber && whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
      const cleanOwner = ownerNumber.replace(/[^0-9]/g, '') + '@c.us';
      whatsappWebBot.sendText(cleanOwner, md).catch(err => {
        console.error('[AI Service] Failed to send WhatsApp order-failure alert:', err.message);
      });
    }
  }

  /**
   * THE single egress for everything this bot says to a customer.
   *
   * All the work happens in _answerQueryImpl(); this wrapper exists only so that the last
   * thing to touch a reply is always the sanitiser, on every path — deterministic template,
   * FAQ, knowledge hit, LLM narration, quota fallback, order-failure apology, and anything
   * added later. Before 2026-09-22 cleaning lived inside one branch of the agentic loop, so
   * it covered exactly the path it was written for and nothing else, and a raw escape
   * fragment reached a real customer mid-sentence.
   *
   * Making this a wrapper rather than a line at each `return` is deliberate: _answerQueryImpl
   * has eleven of them, and the twelfth someone adds next month is covered for free.
   */
  /* ────────────────────────────────────────────────────────────────────────────
   * UNDERSTAND FIRST, THEN ACT (added 2026-09-30)
   *
   * Every message is read for its meaning (services/understand.js) before anything answers
   * it, and the router below ACTS on that meaning in code: cart changes, prices, payment
   * links, delivery days and product lists never come from the model. The keyword chain in
   * _answerQueryImpl runs only when understanding returns null (model down, bad answer,
   * UNDERSTAND_ENABLED=false). See the 2026-09-29 chat in understand.js for why.
   * ──────────────────────────────────────────────────────────────────────────── */

  /** One small no-tools call. Tests stub this method; null = use the keyword chain. */
  async understandMessage(senderId, session, userQuery) {
    if (config.understand?.enabled === false) return null;
    const verdict = await understandService.understand({
      session, message: userQuery, orderState,
      // Always the English provider order (Fireworks first), even for Tanglish. Measured
      // 2026-09-30: sarvam-105b spent the whole 700-token budget on hidden reasoning for this
      // JSON task — /no_think or not — and returned empty content on every Tanglish message,
      // so all of them fell back to keywords. Fireworks returned clean verdicts. The customer-
      // facing Tanglish reply still goes to Sarvam first; this call only reads the message.
      // The retry (attempt 2) gets double the budget: an empty or cut-off verdict is almost
      // always a reasoning model running out of tokens before the JSON.
      callModel: (messages, { attempt = 1 } = {}) => this.callLLMWithFallback(messages, 'english', senderId, {
        noTools: true, maxTokens: (config.understand?.maxTokens || 700) * (attempt > 1 ? 2 : 1), temperature: 0,
      }),
    });
    if (verdict) {
      console.log(`[Understand] ${verdict.intent}${verdict.topic !== 'none' ? `/${verdict.topic}` : ''} mood=${verdict.mood} conf=${verdict.confidence} — ${verdict.meaning}`);
    }
    return verdict;
  }

  /** Send a code-built reply: record it, save, and keep the lead current mid-order. */
  async _replyAndSave(senderId, session, userQuery, text, intent, productIds = []) {
    session.history.push({ role: 'user', content: userQuery });
    session.history.push({ role: 'assistant', content: text });
    session.orderStep = orderState.computeStep(session);
    await this._saveSession(senderId, session);
    // Every customer turn keeps the lead current — not only mid-order. Otherwise a chat that
    // ended on a code-built reply (browse menu, delivery answer…) kept an old updatedAt and
    // whatever status it had before, and the follow-up timer read the wrong conversation.
    await dbService.saveLead({
      userId: senderId,
      name: session.customerName || 'Customer',
      phone: session.customerPhone || senderId.replace(/[^0-9]/g, ''),
      channel: 'whatsapp',
      cart: session.cart || [],
      address: session.address || null,
      requiresEscalation: session.requiresEscalation || false,
      status: 'active',
      conversation: session.history || [],
    });
    return { replyText: text, intent, requiresEscalation: false, suggestedProductIds: productIds };
  }

  /** An order placed recently enough that "delivery?" / "payment?" is about it. */
  _recentOrder(session) {
    const lo = session.lastOrder;
    if (!lo?.orderId) return null;
    return Date.now() - (lo.at || 0) < 7 * 24 * 60 * 60 * 1000 ? lo : null;
  }

  /**
   * One short line that brings a customer mid-order back to where they were, WITHOUT
   * repeating the whole summary or re-asking for details as if nothing was said. Used after
   * answering a side question (delivery, sizing…) during an order.
   */
  _resumeLine(session) {
    const isT = session.language === 'tanglish';
    if (session.cart?.length > 0) {
      if (session.state === 'CONFIRMING_ORDER' && orderState.isAddressComplete(session.addressDetails)) {
        return isT ? 'Order confirm panna "YES" nu reply pannunga 👍' : 'Reply "YES" whenever you\'re ready to confirm the order 👍';
      }
      const missing = orderState.missingAddressFields(this._knownAddress(session));
      if (missing.length > 0) {
        const need = missing.map(f => this._fieldLabel(f, isT).split(' (')[0]).join(', ');
        return isT ? `Order continue panna ${need} anuppunga 👍` : `To continue your order, just send your ${need} 👍`;
      }
      return null;
    }
    if (orderState.lockedProduct(session)) return this._nextStepPrompt(session);
    return null;
  }

  /** Drop a trailing sales question ("Which jersey are you looking at?") from a canned answer. */
  _withoutClosingQuestion(text) {
    const parts = String(text).trim().split(/(?<=[.!?])\s+/);
    if (parts.length > 1 && /\?\s*$/.test(parts[parts.length - 1])) parts.pop();
    return parts.join(' ');
  }

  /**
   * A policy/delivery answer from the store's own FAQ, picked by MEANING (the verdict's
   * topic), not by whether the customer happened to spell a keyword the way faq.json does.
   * Null when there is no entry, or the owner's Rule Book disagrees with its numbers — then
   * the agent answers with the owner's rule cards.
   */
  async _topicAnswer(topic, session) {
    const CATEGORY = {
      delivery: 'Shipping & Delivery', shipping_charge: 'Shipping & Delivery', sizing: 'Sizing & Fit',
      customisation: 'Customization', returns: 'Return & Exchange', quality: 'Jersey Quality',
      versions: 'Version Difference', international: 'Shipping Coverage', care: 'Jersey Care',
      bulk: 'Wholesale / Bulk Orders', tracking: 'Order Tracking', kids: 'Kids Jerseys',
      fc_set: 'FC Set Shorts', giveaway: 'Giveaway', contact: 'Contact & Support',
    };
    const cat = CATEGORY[topic];
    if (!cat) return null;
    await rulesService.refresh();
    if (rulesService.disabledFaqCategories().has(cat)) return null;
    const faq = faqService.getFAQs().find(f => f.category === cat);
    return faq ? faqService.answerFor(faq, session.language) : null;
  }

  /** "Okay" / "no need" / "thanks" — end warmly, and stop selling. */
  _closingReply(session, verdict) {
    const isT = session.language === 'tanglish';
    // Said goodbye in the last 30 minutes already: a thumbs-up is what a person would send.
    // (Not a bare emoji: the egress sanitiser reads an emoji-only reply as broken output.)
    if (session.closedAt && Date.now() - session.closedAt < 30 * 60 * 1000) return isT ? 'Seri 👍' : 'Sure 👍';
    const upset = verdict.mood === 'frustrated' || verdict.mood === 'angry';
    const item = session.cart?.[0];
    const lo = this._recentOrder(session);
    let text;
    if (upset) {
      text = isT
        ? 'Sorry 🙏 naan sariya help pannala. Edhavadhu venumna eppo venumnaalum inga message pannunga.'
        : "Sorry I didn't get that right 🙏 If you need anything, just message here anytime.";
    } else if (item) {
      text = isT
        ? `Seri 👍 *${item.name}* unga cart la save aagi iruku. Venumna eppo venumnaalum "YES" sollunga.`
        : `No problem 👍 *${item.name}* stays in your cart. Just say "YES" whenever you want it.`;
    } else if (lo) {
      text = isT
        ? 'Seri, thanks 🙏 Edhavadhu doubt irundha inga message pannunga.'
        : "You're welcome 🙏 If you have any questions, just message here.";
    } else {
      text = isT
        ? 'Seri 👍 Edhavadhu venumna eppo venumnaalum inga message pannunga.'
        : 'Sure 👍 If you need anything, just message here anytime.';
    }
    session.closedAt = Date.now();
    return text;
  }

  /**
   * Act on an understood message. Returns a reply object (turn over), { agentNote } to go to
   * the agent with the meaning attached, or { rewriteQuery } to continue with a new query.
   */
  async _routeByUnderstanding(senderId, session, userQuery, v) {
    const isT = session.language === 'tanglish';
    // An upset customer gets one short sorry in front of whatever the code does next.
    let sorry = null;
    const reply = (text, intent, ids = []) =>
      this._replyAndSave(senderId, session, userQuery, sorry ? `${sorry}\n${text}` : text, intent, ids);
    const item = session.cart?.[0] || null;
    const locked = orderState.lockedProduct(session);
    const active = Boolean(locked);
    const lo = this._recentOrder(session);
    const several = v.questions.length >= 2;
    if (v.intent !== 'closing') session.closedAt = null;

    // Angry, or frustrated two messages running: say sorry, and when there is nothing concrete
    // to act on, hand the chat to a person instead of guessing again (once per 2 hours).
    const upset = v.mood === 'angry' || (v.mood === 'frustrated' && session.lastMood === 'frustrated');
    session.lastMood = v.mood;
    if (upset && v.intent !== 'closing') {
      sorry = isT ? 'Sorry, en thappu dhaan 🙏' : "Sorry, that's my mistake 🙏";
      const handedOff = session.handoffAt && Date.now() - session.handoffAt < 2 * 60 * 60 * 1000;
      // A bare "hey" from an upset customer is "are you listening?", not a fresh hello — the
      // 2026-10-02 chat got "Sorry" + the full "Vanakkam! Naan Aura…" introduction.
      if (!handedOff && ['other', 'not_understood', 'complaint', 'human_request', 'greeting'].includes(v.intent)) {
        return this._handOffToHuman(senderId, session, userQuery, v);
      }
    }

    // Our own "change the product? YES/NO" question is answered by the order-state turn.
    if (session.pendingClarify) {
      const st = await this._handleOrderStateTurn(senderId, session, userQuery, v);
      if (st) return st;
    }

    if (!item) {
      const pointed = this._pointedProduct(session, userQuery, v);
      // "Ithula / athula vera type?" — more like the jersey they are on (10/2 chat).
      const thisOne = /\b(ithula|idhula|athula|adhula|ithu\s+la|idhu\s+la|athu\s+la|adhu\s+la|in this|like this|like that|similar)\b/i.test(userQuery);
      const base = pointed || locked;
      if (thisOne && base && (['list_more', 'browse_catalogue', 'list_teams'].includes(v.intent) || (v.intent === 'product_search' && !v.search))) {
        if (pointed) this._lockProduct(session, pointed);
        return reply(this._moreLikeThisReply(session, base), 'understood_more_like_this', [base.productId]);
      }
      // "9 la enna iruku?" — a plain "what is number 9?", answered from the list on screen.
      // Only when nothing but the number and question words is there; anything more specific
      // ("9 la full sleeve iruka?") goes to the agent with the meaning attached.
      const rest = String(userQuery).toLowerCase().replace(/(?<![\d₹.])\d{1,2}(?![\d%])/, ' ').replace(/[?!.,]/g, ' ').split(/\s+/).filter(Boolean);
      const GENERIC = /^(la|le|enna|ennaa|ena|what|whats|what's|is|in|it|details?|iruku|irukku|irukoh|iruka|irukka|bro|anna|sollunga|solunga|about|number|no|option|options|item|jersey|pathi|patthi|info|show|kaatunga|katunga)$/;
      if (pointed && !v.size && !v.qty && rest.length > 0 && rest.every(w => GENERIC.test(w)) && /enna|ena|what|details?|info|pathi|patthi|\?/i.test(userQuery)) {
        return reply(this._productDetailReply(session, pointed), 'understood_product_detail', [pointed.productId]);
      }
    }

    switch (v.intent) {
      case 'closing':
        return reply(this._closingReply(session, v), 'understood_closing');

      case 'greeting': {
        if (item) {
          return reply(isT
            ? `Hi! 👋 Unga cart la *${item.name}* (${item.size}, ${item.qty} qty) save aagi iruku. Adhe continue pannalama, illa vera jersey paakanuma?`
            : `Hi! 👋 You still have *${item.name}* (Size ${item.size}, Qty ${item.qty}) in your cart. Would you like to continue with it, or look at something else?`,
          'understood_greeting');
        }
        const g = faqService.getFAQs().find(f => f.category === 'Greetings');
        const text = g ? faqService.answerFor(g, session.language) : null;
        return text ? reply(text, 'understood_greeting') : { agentNote: true };
      }

      case 'pause_order':
        if (!item && !locked) return reply(this._closingReply(session, v), 'understood_closing');
        return reply(isT
          ? `Seri, no problem 👍 *${(item || locked).name}* ah cart la vechirukken. Venumna "YES" sollunga, vendaamna "cancel" nu sollunga.`
          : `No problem 👍 I'll keep *${(item || locked).name}* in your cart. Say "YES" when you want it, or "cancel" to remove it.`,
        'understood_pause');

      case 'cancel_cart': {
        if (!active) {
          if (lo && v.aboutPlacedOrder) return { agentNote: true };
          return reply(isT ? 'Unga cart already empty dhaan 👍 Vera edhavadhu venumna sollunga.' : 'Your cart is already empty 👍 Let me know if you need anything else.', 'understood_cancel_cart');
        }
        const name = (item || locked).name;
        // "Address change panniten" → "Ithu venaam": the "this" was the ADDRESS, and the bot
        // removed the jersey (2026-10-01). When the address is what was being talked about
        // and the jersey isn't named, ask — once — before deleting anything.
        const prevUser = [...(session.history || [])].reverse().find(m => m.role === 'user')?.content || '';
        const aboutAddress = /\b(address|addr|adress|addres)\b/i.test(`${userQuery} ${prevUser}`);
        const namesJersey = Boolean(v.search) || /\b(jersey|jersy|jersi|shirt|order|cart|product|item|remove)\b/i.test(userQuery);
        const askedRecently = session.cancelAskedAt && Date.now() - session.cancelAskedAt < 10 * 60 * 1000;
        if (aboutAddress && !namesJersey && !askedRecently) {
          session.cancelAskedAt = Date.now();
          return reply(isT
            ? `Jersey (*${name}*) ah remove pannanuma, illa address mattum maathanuma? 🙂\n• Address maathanum na "address" nu sollunga\n• Jersey venaam na "jersey remove" nu sollunga`
            : `Do you want to remove the jersey (*${name}*), or only change the address? 🙂\n• To change the address, reply "address"\n• To remove the jersey, reply "remove jersey"`,
          'understood_cancel_clarify');
        }
        this._rememberRemovedCart(session);
        this._clearOrderSelection(session);
        session.lastShownProducts = [];
        if (v.search) return { rewriteQuery: v.search, notePrefix: isT ? `*${name}* ah cart la irundhu remove panniten 👍` : `I've removed *${name}* from your cart 👍` };
        return reply(isT
          ? `Done 👍 *${name}* ah cart la irundhu remove panniten. Vera jersey venumna sollunga.\n(Thappa remove aayiduchuna "undo" nu sollunga.)`
          : `Done 👍 I've removed *${name}* from your cart. Let me know if you'd like anything else.\n(Removed by mistake? Reply "undo".)`,
        'understood_cancel_cart');
      }

      case 'restore_cart': {
        const rc = this._recentlyRemovedCart(session);
        if (!rc || active) return { agentNote: true };
        this._restoreRemovedCart(session);
        sorry = null; // the lead below already apologises
        const it = session.cart[0];
        const ids = it ? [it.productId] : [];
        const lead = it
          ? (isT ? `Sorry 🙏 en thappu. *${it.name}* — ${it.size} size, ${it.qty} qty thirumba cart la vechitten ✅`
                 : `Sorry 🙏 my mistake. *${it.name}* — Size ${it.size}, Qty ${it.qty} is back in your cart ✅`)
          : (isT ? 'Sorry 🙏 en thappu. Neenga select panna jersey thirumba vechitten ✅' : "Sorry 🙏 my mistake. Your jersey is back ✅");
        // "Don't remove it, I only want to change the address" — do both.
        if (it && /\b(address|addr|adress|addres)\b/i.test(`${userQuery} ${v.meaning}`)) {
          return reply(this._startAddressChange(session, lead), 'understood_restore_cart', ids);
        }
        return reply(`${lead}\n${this._nextStepPrompt(session)}`, 'understood_restore_cart', ids);
      }

      case 'change_address': {
        let lead = '';
        // The jersey was removed by mistake on the way here: put it back first.
        if (!session.cart?.length && this._restoreRemovedCart(session)) {
          const it = session.cart[0];
          if (it) lead = isT
            ? `*${it.name}* — ${it.size} size, ${it.qty} qty thirumba cart la vechitten ✅ Pazhaya address ah eduthutten.`
            : `*${it.name}* — Size ${it.size}, Qty ${it.qty} is back in your cart ✅ I've removed the old address.`;
        }
        // No cart: a placed order's address is the team's to change — the agent raises it.
        if (!session.cart?.length) return { agentNote: true };
        // The new address may already be in this message: clear the old one and read it.
        const parts = orderState.parseAddressParts(userQuery);
        if (parts.phone || parts.pincode) {
          this._startAddressChange(session);
          const st = await this._handleOrderStateTurn(senderId, session, userQuery, { ...v, intent: 'give_address' });
          if (st && typeof st.replyText === 'string') return st;
        }
        return reply(this._startAddressChange(session, lead), 'understood_change_address', [session.cart[0].productId]);
      }

      case 'start_over': {
        const had = active ? (item || locked).name : null;
        this._rememberRemovedCart(session);
        this._clearOrderSelection(session);
        session.lastShownProducts = [];
        session.pendingBrowse = false;
        session.lastListContext = null;
        // "Forget me and my data": clear the details this conversation holds, and be honest
        // that stored order records are the team's to delete.
        const forget = /\b(data|details|forget|delete|erase|remove my)\b/i.test(v.meaning);
        if (forget) {
          session.addressDetails = null; session.addressDraft = null; session.customerProfile = null; session.address = null;
        }
        const lead = isT
          ? `Seri 👍${had ? ` *${had}* cart la irundhu remove panniten.` : ''}${forget ? ' Unga saved address, phone details clear panniten. Order records full ah delete pannanumna team kitta solren — sollunga.' : ''}`
          : `Done 👍${had ? ` I've removed *${had}* from your cart.` : ''}${forget ? " I've cleared the address and phone details saved in this chat. If you also want your past order records deleted, tell me and I'll ask the team." : ''}`;
        return reply(`${lead}\n${isT ? 'Fresh ah start pannalaam — enna jersey venum?' : "Let's start fresh — which jersey are you looking for?"}`, 'understood_start_over');
      }

      case 'payment_question': {
        let text = this._paymentReply(session);
        if (v.topic === 'cod' && lo && !active && !config.payment?.codEnabled) {
          text = `${isT ? 'Sorry, COD illa — prepaid mattum dhaan 🙏' : 'Sorry, COD is not available — prepaid only 🙏'}\n${text}`;
        }
        return reply(text, 'understood_payment');
      }

      case 'order_status': {
        // "Already ordered, payment pending" about the order this chat just placed — say what
        // we know. Anything needing a lookup (an order number, tracking) goes to the agent.
        if (lo && !/\d{4,}/.test(userQuery.replace(String(lo.orderId), '')) && !several) {
          const pay = lo.checkoutUrl
            ? (isT ? `Payment mattum pending — idhu link:\n${lo.checkoutUrl}` : `Only the payment is pending — here's the link:\n${lo.checkoutUrl}`)
            : (isT ? 'Payment link team seekiram anuppuvaanga.' : 'The team will send your payment link shortly.');
          return reply(isT ? `Aamaa, unga order #${lo.orderId} place aayiduchu ✅\n${pay}` : `Yes, your order #${lo.orderId} is placed ✅\n${pay}`, 'understood_order_status');
        }
        return { agentNote: true };
      }

      case 'delivery_question':
      case 'policy_question': {
        if (several) return { agentNote: true };
        const topic = v.intent === 'delivery_question' && (v.topic === 'none' || !v.topic) ? 'delivery' : v.topic;
        // A hand-taught answer from the owner wins, as it always has — now also mid-order.
        const kh = await knowledgeService.match(userQuery, session.language).catch(() => null);
        let answer = kh && kh.tier === 'confident' ? kh.entry.answer : await this._topicAnswer(topic, session);
        if (!answer) return { agentNote: true };
        const resume = this._resumeLine(session);
        if (resume || lo) answer = this._withoutClosingQuestion(answer);
        if (lo && !active && ['delivery', 'tracking', 'shipping_charge'].includes(topic)) {
          answer = `${isT ? `Unga order #${lo.orderId} ku:` : `About your order #${lo.orderId}:`} ${answer}`;
          if (lo.checkoutUrl && lo.at && Date.now() - lo.at < 24 * 60 * 60 * 1000) {
            answer += isT ? `\nPayment innum pending na, idhu link:\n${lo.checkoutUrl}` : `\nIf the payment is still pending, here's the link:\n${lo.checkoutUrl}`;
          }
        }
        return reply(resume ? `${answer}\n\n${resume}` : answer, 'understood_policy', locked ? [locked.productId] : []);
      }

      case 'browse_catalogue': {
        const text = this.browseMenuReply(session.language, session);
        return text ? reply(text, 'understood_browse') : { agentNote: true };
      }

      case 'list_teams': {
        if (v.category !== 'none') {
          const teams = woocommerceService.teamsInGroup(v.category, 15);
          const group = woocommerceService.listCatalogueGroups().find(g => g.key === v.category);
          if (teams.length > 0 && group) {
            const list = teams.map(t => `• ${t}`).join('\n');
            session.lastListContext = { type: 'group', key: v.category };
            return reply(isT
              ? `${group.emoji} *${group.label}* la idhellaam iruku 👇\n\n${list}\n\nEdhu venum? Peru sollunga, naan jerseys kaatturen ⚽`
              : `${group.emoji} In *${group.label}* we have 👇\n\n${list}\n\nWhich one would you like? Tell me the name and I'll show you the jerseys ⚽`,
            'understood_teams');
          }
        }
        const text = this.teamListReply(session.language, session);
        return text ? reply(text, 'understood_teams') : { agentNote: true };
      }

      case 'list_more': {
        const ctx = session.lastListContext;
        if (ctx?.type === 'group' || (!ctx && v.category !== 'none')) {
          // Same rule as the search shelf below: never resend a list they have already seen
          // (10/2: the same ten club jerseys went out twice in two minutes).
          const key = ctx?.key || v.category;
          const seen = new Set((session.lastShownProducts || []).map(p => String(p.productId)));
          const next = woocommerceService.bestSellersInGroup(key, 10);
          if (next.length > 0 && next.every(p => seen.has(String(p.id)))) {
            if (locked && !item) return reply(this._moreLikeThisReply(session, locked), 'understood_more_like_this', [locked.productId]);
            const group = woocommerceService.listCatalogueGroups().find(g => g.key === key);
            const diff = this._somethingDifferentReply(session, userQuery, v, group?.label || '', next.length);
            if (diff) return reply(diff.text, diff.intent, diff.ids);
          }
          const text = this.bestSellersReply(key, session, 10);
          if (text) return reply(text, 'understood_list_more', (session.lastShownProducts || []).map(p => p.productId));
        }
        if (ctx?.type === 'search' && ctx.query) {
          const found = woocommerceService.searchProductsDetailed(ctx.query);
          const all = found.products.slice(0, 10);
          // "Show other teams" / "Arsenal illama vera" / "other best sellers" were read as
          // "more of this list", and the same one-shirt Arsenal search was re-run and re-sent
          // five times (2026-10-02). If the shelf has nothing the customer hasn't already seen,
          // "more" can only mean "something DIFFERENT" — never send the same list again.
          const seen = new Set((session.lastShownProducts || []).map(p => p.productId));
          if (all.length === 0 || all.every(p => seen.has(p.id))) {
            const diff = this._somethingDifferentReply(session, userQuery, v, ctx.query, all.length);
            if (diff) return reply(diff.text, diff.intent, diff.ids);
            return { agentNote: true };
          }
          if (all.length > 0) {
            session.lastShownProducts = all.map(p => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: p.permalink || '' }));
            session.productListPending = true;
            session.pendingProductIndex = null;
            const lines = all.map((p, i) => `${i + 1}. *${p.name}* — ₹${p.price}${p.sizes?.length ? ` [${p.sizes.join(', ')}]` : ''}${p.permalink ? `\n${p.permalink}` : ''}`).join('\n');
            const range = all.length > 1 ? `1–${all.length}` : '1';
            return reply(isT
              ? `Stock la irukura ellaam 👇\n${lines}\n\nEdhu venum (${range})? Size, quantity-um sollunga 🛍️`
              : `Here's everything we have 👇\n${lines}\n\nWhich one would you like (${range})? Tell me the size and quantity too 🛍️`,
            'understood_list_more', all.map(p => p.id));
          }
        }
        if (v.search) return { rewriteQuery: v.search };
        return { agentNote: true };
      }

      case 'product_search': {
        // They asked for something else while a product is in the cart. The cart holds one
        // product, so the new request replaces it — and we say so, instead of reading their
        // words as an address or pushing the old order (2026-09-29: "I want Man City jersey").
        let notePrefix = null;
        if (active && v.search) {
          const norm = s => String(s || '').toLowerCase();
          // Same product named again ("the Barcelona one in L") keeps it.
          const sameProduct = norm(locked.name).includes(norm(v.search));
          if (!sameProduct) {
            notePrefix = isT ? `*${locked.name}* ah cart la irundhu remove panniten.` : `I've taken *${locked.name}* out of your cart.`;
            this._clearOrderSelection(session);
          }
        }
        if (!v.search && v.category !== 'none') {
          const text = this.bestSellersReply(v.category, session, 3);
          if (text) return reply(notePrefix ? `${notePrefix}\n${text}` : text, 'understood_browse_pick', (session.lastShownProducts || []).map(p => p.productId));
        }
        return { agentNote: true, notePrefix };
      }

      case 'pick_product':
      case 'size_qty':
      case 'give_address':
      case 'confirm_order': {
        if (v.intent === 'confirm_order' && session.state === 'CONFIRMING_ORDER') return { confirm: true };
        // A menu pick ("2" after the category menu).
        if (v.intent === 'pick_product' && session.pendingBrowse && Array.isArray(session.browseGroups)) {
          session.pendingBrowse = false;
          const key = (v.pick && session.browseGroups[v.pick - 1]?.key) || woocommerceService.matchGroupChoice(userQuery, session.browseGroups);
          const text = key ? this.bestSellersReply(key, session) : null;
          if (text) return reply(text, 'deterministic_browse_pick', (session.lastShownProducts || []).map(p => p.productId));
        }
        const st = await this._handleOrderStateTurn(senderId, session, userQuery, v);
        if (st && st.rewriteQuery) return { rewriteQuery: st.rewriteQuery };
        if (st) return st;
        return { agentNote: true };
      }

      case 'complaint':
        if (isT && !active && !/\d{4,}/.test(userQuery)
            && !(session.complaintAskedAt && Date.now() - session.complaintAskedAt < 30 * 60 * 1000)) {
          session.complaintAskedAt = Date.now();
          return reply('Romba sorry 🙏 Idha naanga kandippa sort out panrom.\n'
            + 'Unga order ID um, enna problem nu oru line la anuppunga. Photo irundha adhuvum anuppunga.\n'
            + 'Team udane check pannuvaanga.', 'deterministic_complaint');
        }
        return { agentNote: true };

      default:
        // "Enna bro pesuradhe purila" — they could not understand US. The recovery must not be
        // written by the model whose language just failed (see the 2026-09-22 note), so it is
        // fixed text: sorry once, then plain English with the real team list.
        if ((v.intent === 'not_understood' || (v.intent === 'other' && v.mood === 'confused')) && !active) {
          const teams = woocommerceService.listTeams(8);
          const list = teams.length > 0 ? `\n\n${teams.map(t => `• ${t}`).join('\n')}\n` : ' ';
          return reply(isT
            ? `Sorry 🙏 simple ah solren. Namma stock la idhellaam iruku:${list}\nOru team name type pannunga (example: "Real Madrid") — naan price, size ellaam anuppuren.`
            : `Sorry about that! 🙏 Let me keep it simple. Here's what we have in stock:${list}\nJust type one team name (for example "Real Madrid") and I'll send you the price and sizes.`,
          'deterministic_clarify');
        }
        // product_question, cancel_placed_order, human_request, other — the agent answers,
        // with the meaning attached.
        return { agentNote: true };
    }
  }

  /** The meaning, handed to the agent as a note right before the customer's message. */
  _understandingNote(v, session) {
    const lines = [`WHAT THE CUSTOMER MEANS (read from the whole chat — trust this over the literal words): ${v.meaning || v.intent}`];
    if (v.questions.length > 0) lines.push(`Their question(s), answer EVERY one, in order: ${v.questions.map((q, i) => `${i + 1}) ${q}`).join(' ')}`);
    if (v.mood === 'frustrated' || v.mood === 'angry') lines.push('They are frustrated with the previous replies: start with one short, sincere sorry, then answer exactly what they asked. Do not repeat a list you already sent.');
    const lo = this._recentOrder(session);
    if (lo && !orderState.hasActiveOrder(session)) lines.push(`This customer ALREADY PLACED order #${lo.orderId}${lo.checkoutUrl ? ` (payment link: ${lo.checkoutUrl})` : ''}. Questions about delivery/payment are about that order. Never ask them to place an order again.`);
    if (!['product_search', 'list_more', 'list_teams', 'browse_catalogue'].includes(v.intent)) {
      lines.push('They did NOT ask to see products. Do not call search_products and do not list teams unless their question needs it.');
    }
    return lines.join('\n');
  }

  async answerQuery(senderId, userQuery, customerName = null, customerPhone = null, options = {}) {
    // ONE turn per customer at a time, for EVERY caller. The WhatsApp handler already chains
    // messages per sender, but three other paths call in here outside that chain — the
    // in-memory quota retry timer, the persistent retry queue, and the catch-up sweep. Each
    // does getSession → (seconds of LLM work) → saveSession, so any of them overlapping a live
    // message let the slower turn write back a stale session over the newer one (a cart, a
    // size or an address silently reverting). Serialising here covers all of them at once.
    return this._withSenderLock(senderId, () => this._answerQueryLocked(senderId, userQuery, customerName, customerPhone, options));
  }

  async _withSenderLock(senderId, fn) {
    const key = String(senderId || '');
    const previous = this._senderLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this._senderLocks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this._senderLocks.get(key) === tail) this._senderLocks.delete(key);
    }
  }

  /**
   * Version-aware save. dbService.saveSession() refuses to overwrite a session that another
   * writer (a second bot process during a deploy, for instance) saved after we loaded it, and
   * reports 'conflict'. Recorded here so answerQuery can reload and re-run the turn.
   */
  async _saveSession(senderId, session) {
    const res = await dbService.saveSession(senderId, session);
    if (res === 'conflict') {
      const meta = this._turnMeta.get(String(senderId));
      if (meta) meta.conflict = true;
    }
    return res;
  }

  _markSideEffect(senderId) {
    const meta = this._turnMeta.get(String(senderId));
    if (meta) meta.sideEffects = true;
  }

  async _answerQueryLocked(senderId, userQuery, customerName = null, customerPhone = null, options = {}) {
    let result;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const meta = { conflict: false, sideEffects: false };
      this._turnMeta.set(String(senderId), meta);
      try {
        result = await this._answerQueryImpl(senderId, userQuery, customerName, customerPhone, options);
      } finally {
        this._turnMeta.delete(String(senderId));
      }
      // Our write lost to a newer one. Re-run the turn on the fresh state — but only when
      // nothing irreversible happened (an order or ticket must never be created twice).
      if (meta.conflict && !meta.sideEffects && attempt === 1) {
        console.warn(`[AI Service] Session version conflict for ${senderId} — reloading state and re-running the turn.`);
        continue;
      }
      if (meta.conflict) {
        console.error(`[AI Service] Session version conflict for ${senderId} could not be retried safely (side effects already ran). The newer stored state was kept.`);
      }
      break;
    }
    // A delayed retry that the conversation has already moved past: say nothing.
    if (result && result.intent === 'stale_retry') return result;
    if (!result || typeof result.replyText !== 'string') return result;

    const cleaned = this.sanitizeOutgoing(result.replyText);
    // Compare with whitespace ignored. The sanitiser also tidies spacing, and some product
    // names in WooCommerce genuinely carry double spaces ("HOME —  MESSI"), so a plain !==
    // logged a leak warning on perfectly healthy replies — which is how a real warning ends
    // up being ignored.
    if (cleaned && cleaned.replace(/\s+/g, '') !== result.replyText.replace(/\s+/g, '')) {
      console.warn(`[AI Service] Egress sanitiser cleaned a ${result.intent} reply before sending:`,
        result.replyText.slice(0, 160));
    }
    if (cleaned) {
      result.replyText = cleaned;
      return result;
    }

    // Nothing survived, so the reply WAS the leak. The session is only read here, on a path
    // that should essentially never run, to get the apology into the right language — doing
    // it unconditionally would add a database read to every single message.
    console.error('[AI Service] Reply was entirely machine output — replaced with an apology:',
      result.replyText.slice(0, 200));
    const session = await dbService.getSession(senderId).catch(() => null);
    result.replyText = this.brokenReplyFallback(session?.language || 'english');
    return result;
  }

  async _answerQueryImpl(senderId, userQuery, customerName = null, customerPhone = null, options = {}) {
    const session = await dbService.getSession(senderId);
    // A delayed retry of a message the customer has since followed up on. Answering it now
    // would process an old message against newer state, so drop it (see scheduleQuotaRetry).
    if (options.queuedAt && session.lastActive
        && new Date(session.lastActive).getTime() > options.queuedAt + 2000) {
      return { replyText: '', intent: 'stale_retry', requiresEscalation: false, suggestedProductIds: [] };
    }
    if (customerName && customerName !== 'Customer') session.customerName = customerName;
    if (customerPhone) session.customerPhone = customerPhone;
    // A photo/image just arrived on WhatsApp — remember it so a support ticket raised in
    // this or the next turn is tagged "photo received" (the owner sees the forwarded image).
    if (options.hasMedia) session.photoReceived = true;

    // Detect language every turn, but only ever move TOWARD Tanglish, never away from
    // it. A neutral opener like "hi" carries no signal and used to lock the whole
    // conversation into English permanently before a real Tanglish word ever showed up
    // (e.g. "iruka bro" on message 2) — now a Tanglish word on ANY turn switches the
    // session over and stays there; plain-English replies afterward (numbers, product
    // names) no longer flip it back.
    // Re-detect language on a FRESH conversation. session.language is otherwise sticky for
    // the whole session (below), but a session persists across days — so a returning customer
    // kept whatever language was locked in a PREVIOUS chat even if they now open in the other
    // language. If this message starts a new conversation (long idle gap since last activity),
    // drop the old lock so detection decides fresh from this turn.
    const NEW_CONVERSATION_GAP_MS = 6 * 60 * 60 * 1000; // 6h
    const lastActiveMs = session.lastActive ? new Date(session.lastActive).getTime() : 0;
    if (lastActiveMs && (Date.now() - lastActiveMs) > NEW_CONVERSATION_GAP_MS) {
      session.language = null;
    }

    const detected = this.detectLanguage(userQuery);
    if (detected === 'tanglish') {
      session.language = 'tanglish';
    } else if (!session.language) {
      session.language = 'english';
    }

    session.history = session.history || [];

    // Log to Google Sheets and save customer record on first contact
    // (tracked via an explicit flag, not history.length, since the quota-exhausted
    // path below intentionally skips appending to history on retry)
    if (!session.firstContactLogged) {
      session.firstContactLogged = true;
      const phone = customerPhone || senderId.replace(/[^0-9]/g, '');
      sheetsService.appendRow([
        new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        phone,
        customerName || 'Customer',
        userQuery
      ]).catch(e => console.error(e));

      dbService.saveCustomer(senderId, customerName, phone).catch(() => {});
    } else if (customerName && customerName !== 'Customer') {
      // Keep customer record updated with latest name
      dbService.saveCustomer(senderId, customerName, customerPhone || session.customerPhone).catch(() => {});
    }

    const validHistory = session.history.filter(m => m.role === 'user' || m.role === 'assistant');
    // Ten messages (five exchanges), up from four. Four meant an address sent two turns
    // earlier had already scrolled out of the model's view — the root of "already send
    // paniten" being answered with another request for the address. The order facts no
    // longer depend on history at all (they live in structured fields, see
    // _handleOrderStateTurn), but the model still needs enough conversation to read tone.
    session.history = validHistory.slice(-10);

    let resultText = "";
    let isConfirmed = false;
    // Whether search_products actually ran this turn -- used to stop the model asking the
    // customer to "be more specific" about something it never looked up. See the guard below.
    let searchRanThisTurn = false;
    let requiresEscalation = false;
    let checkoutUrl = null;
    let quotaExhaustedWaitMs = null;
    let matchedProductIds = [];

    if (this.groqClients.length === 0 && this.openaiClients.length === 0 && this.openrouterClients.length === 0 && this.fireworksClients.length === 0 && this.sarvamClients.length === 0 && this.geminiClients.length === 0) {
      resultText = "I'm currently undergoing maintenance. Please reach out to our support number directly on WhatsApp.";
      return { replyText: resultText, intent: 'error', requiresEscalation: false, suggestedProductIds: [] };
    }

    // --- Understand first (added 2026-09-30) ---
    // The message is read for its MEANING, with the chat and the order state, and code acts
    // on that. The keyword chain below runs only when this returns null. See understand.js.
    let verdict = null;
    let agentNote = null;
    let notePrefix = null;
    let forceConfirm = false;
    if (userQuery && userQuery.trim()) {
      verdict = await this.understandMessage(senderId, session, userQuery);
    }
    if (verdict) {
      const routed = await this._routeByUnderstanding(senderId, session, userQuery, verdict);
      if (routed && typeof routed.replyText === 'string') return routed;
      if (routed?.rewriteQuery) userQuery = routed.rewriteQuery;
      if (routed?.notePrefix) notePrefix = routed.notePrefix;
      if (routed?.confirm) forceConfirm = true;
      if (!routed?.confirm) agentNote = this._understandingNote(verdict, session);
    }

    // ── Keyword chain: ONLY when the message could not be understood (model down). ──
    if (!verdict && userQuery) {
      // Address change / undo a removal. On 2026-10-01 the understanding call came back empty
      // for exactly these messages, and the chain below had nothing for them: "keep the
      // jersey, only change the address" got the team list three times.
      const q = userQuery;
      const mentionsAddress = /\b(address|addr|adress|addres)\b/i.test(q);
      const wantsChange = /\b(change|maath\w*|maatt\w*|math\w*|venaam|vendaam|venam|vera|thappu|wrong|new|pudhu|puthu)\b/i.test(q);
      const keepJersey = /\b(undo|remove\s+(?:panna\w*|pannadh\w*|pannath\w*)|don'?t\s+remove|keep\s+(?:it|the\s+jersey)|jersey\s+(?:okay|ok|ok\s+dhaan|venum|irukkatum))\b/i.test(q);
      const parts = orderState.parseAddressParts(q);
      const quickReply = (text, intent, ids = []) => this._replyAndSave(senderId, session, q, text, intent, ids);
      const isT = session.language === 'tanglish';
      if (keepJersey && !session.cart?.length && this._recentlyRemovedCart(session)) {
        this._restoreRemovedCart(session);
        const it = session.cart[0];
        const lead = isT ? `Sorry 🙏 en thappu. *${it.name}* — ${it.size} size, ${it.qty} qty thirumba cart la vechitten ✅`
                         : `Sorry 🙏 my mistake. *${it.name}* — Size ${it.size}, Qty ${it.qty} is back in your cart ✅`;
        return quickReply(mentionsAddress ? this._startAddressChange(session, lead) : `${lead}\n${this._nextStepPrompt(session)}`, 'keyword_restore_cart', [it.productId]);
      }
      if (mentionsAddress && wantsChange && !parts.phone && !parts.pincode) {
        let lead = '';
        if (!session.cart?.length && this._restoreRemovedCart(session)) {
          const it = session.cart[0];
          lead = isT ? `*${it.name}* — ${it.size} size, ${it.qty} qty thirumba cart la vechitten ✅ Pazhaya address ah eduthutten.`
                     : `*${it.name}* — Size ${it.size}, Qty ${it.qty} is back in your cart ✅ I've removed the old address.`;
        }
        if (session.cart?.length) return quickReply(this._startAddressChange(session, lead), 'keyword_change_address', [session.cart[0].productId]);
      }
    }
    if (!verdict) {
      // --- Deterministic "start a new order" reset ---
      // MUST run before the isIdle gate below, because its whole purpose is to rescue a
      // session that is NOT idle.
      //
      // Every fast path (FAQ, knowledge, size/qty, product selection) is gated on
      // `cart.length === 0`. Nothing used to clear the cart except completing or abandoning
      // an order, so a customer who finished one purchase and typed "hi new order" stayed
      // in COLLECTING_ADDRESS with a stale cart FOREVER. From that point every message went
      // to the LLM, which — seeing a filled cart and an address-collection state — answered
      // "1"/"M 5"/"s 3" by re-running search_products and re-printing the same list. That is
      // the infinite product-list loop reported from production 2026-08-05, reproduced
      // exactly: turn 2 deterministic_cart, then every later turn agent_handled with
      // cart=1 / state=COLLECTING_ADDRESS.
      //
      // Deliberately narrow: an explicit restart phrase in a SHORT message, and never when
      // the message looks like a question about an EXISTING order ("where is my new order",
      // "cancel my order") — those are tracking/cancellation intents, not a restart.
      if (userQuery && userQuery.trim().length <= 40) {
        const q = userQuery.trim();
        const wantsRestart = /\b(?:(?:new|another|fresh|next|one more|1 more)\s+(?:order|jersey|item|purchase)|start\s+(?:over|again|fresh)|restart|reset|clear\s+(?:my\s+)?cart|vera\s+(?:order|jersey)|innoru\s+(?:order|jersey))\b/i.test(q);
        const isAboutExistingOrder = /\b(where|track|tracking|status|cancel|delivered|arrived|received|refund|return)\b/i.test(q);
        if (wantsRestart && !isAboutExistingOrder) {
          const hadCart = session.cart.length > 0 || Boolean(session.selectedProduct);
          this._clearOrderSelection(session);
          // Cleared too, so a later bare "1" can't select from the PREVIOUS order's list.
          session.lastShownProducts = [];
          const reply = session.language === 'tanglish'
            ? `Sure! ${hadCart ? 'Pazhaya cart clear pannaachu. ' : ''}Fresh ah start pannalam — enna team illa player jersey venum? Real Madrid, Barcelona, Ronaldo, Messi… sollunga! ⚽`
            : `Sure thing! 🔥 ${hadCart ? "Cleared your previous cart. " : ''}Let's start fresh — which team or player are you looking for? Real Madrid, Barcelona, Ronaldo, Messi… just tell me! ⚽`;
          session.history.push({ role: 'user', content: userQuery });
          session.history.push({ role: 'assistant', content: reply });
          await this._saveSession(senderId, session);
          return { replyText: reply, intent: 'deterministic_reset', requiresEscalation: false, suggestedProductIds: [] };
        }
      }

      // --- Deterministic order-state turn (added 2026-09-22) ---
      // Everything that is really a state change — picking from the list, size, quantity,
      // shipping details, "already sent", a payment question mid-order, "change product" — is
      // read from the customer's words against the structured state and applied in code. See
      // _handleOrderStateTurn. Runs before the FAQ/teams paths so a customer mid-order is
      // never answered with a discovery reply.
      const stateTurn = await this._handleOrderStateTurn(senderId, session, userQuery);
      if (stateTurn && stateTurn.rewriteQuery) {
        userQuery = stateTurn.rewriteQuery;
      } else if (stateTurn) {
        return stateTurn;
      }

      // --- Tanglish complaint: a fixed first reply (added 2026-09-29) ---
      // The client's example of a "meaningless" reply was a complaint answered in free-written
      // Tamil: "Service miss pannite ah naurom nu ninaikirenga nu puriyuthu … appo pathi naan
      // immediate ah look panniten" — an invented word, chained clauses, and a claim to have
      // ALREADY looked. A complaint's first reply always has the same job (sorry, send the order
      // ID and the problem, the team will check), so it is written once, by a person, in plain
      // Tanglish. Once they send the order ID the agent takes over and raises the ticket.
      // Skipped when the message already carries an order number, mid-order (a "wrong size"
      // there is a correction, not a complaint), and if we asked in the last 30 minutes.
      if (session.language === 'tanglish' && userQuery && !orderState.hasActiveOrder(session)
          && (tanglishReader.isComplaint(userQuery) || tanglishReader.isUpset(userQuery))
          && !/\d{4,}/.test(userQuery)
          && !(session.complaintAskedAt && Date.now() - session.complaintAskedAt < 30 * 60 * 1000)) {
        const reply = 'Romba sorry 🙏 Idha naanga kandippa sort out panrom.\n'
          + 'Unga order ID um, enna problem nu oru line la anuppunga. Photo irundha adhuvum anuppunga.\n'
          + 'Team udane check pannuvaanga.';
        session.complaintAskedAt = Date.now();
        session.history.push({ role: 'user', content: userQuery });
        session.history.push({ role: 'assistant', content: reply });
        await this._saveSession(senderId, session);
        return { replyText: reply, intent: 'deterministic_complaint', requiresEscalation: false, suggestedProductIds: [] };
      }

      // --- Pre-AI FAQ Matcher ---
      // Answer common FAQ queries directly WITHOUT using any LLM tokens (faster, zero leak risk).
      // CRITICAL: Only run when session is IDLE — NOT during an active order flow where
      // the user might be specifying a size ("M"), address, or confirming an order.
      const isIdle = !session.state || session.state === 'IDLE';
      if (isIdle && session.cart.length === 0 && userQuery) {
        // --- Knowledge Hub pre-check (client-taught corrections) ---
        // Runs BEFORE the static FAQ matcher so a correction the client saved via the
        // /knowledge-hub page always wins over the hard-coded default. A CONFIDENT match is
        // answered directly with zero LLM (like FAQ); softer matches fall through and are
        // injected into the LLM context below instead. Language-scoped in the matcher.
        const knowledgeHit = await knowledgeService.match(userQuery, session.language);
        if (knowledgeHit && knowledgeHit.tier === 'confident') {
          const answer = knowledgeHit.entry.answer;
          session.history.push({ role: 'user', content: userQuery });
          session.history.push({ role: 'assistant', content: answer });
          await this._saveSession(senderId, session);
          return { replyText: answer, intent: 'knowledge', requiresEscalation: false, suggestedProductIds: [] };
        }



        // --- Guided browse, step 2: the customer picked a category off the menu ---
        // Read and CLEAR the flag first, whether or not it resolves. A customer who ignores the
        // menu and asks something else must not leave a live "pick a category" state behind for
        // a later, unrelated "2" to be swallowed by.
        const awaitingGroupPick = session.pendingBrowse === true;
        const offeredGroups = Array.isArray(session.browseGroups) ? session.browseGroups : [];
        if (awaitingGroupPick) {
          session.pendingBrowse = false;
          const picked = woocommerceService.matchGroupChoice(userQuery, offeredGroups);
          // null falls through to the normal agent, which is always safe -- "Real Madrid" typed
          // at the menu is a search, not a bad category guess.
          const reply = picked ? this.bestSellersReply(picked, session) : null;
          if (reply) {
            session.history.push({ role: 'user', content: userQuery });
            session.history.push({ role: 'assistant', content: reply });
            await this._saveSession(senderId, session);
            return {
              replyText: reply,
              intent: 'deterministic_browse_pick',
              requiresEscalation: false,
              suggestedProductIds: (session.lastShownProducts || []).map(p => p.productId),
            };
          }
        }
        // --- Deterministic "which teams do you have?" answer (added 2026-09-22) ---
        // "Enna enna team la iruke?" has no search term in it, so search_products returns
        // nothing and there is no tool that answers it. Left to the LLM, the 2026-09-21 chat
        // shows what happens: it answered the question with another question three times in a
        // row, and padded it with a list off the top of its head — Mbappe, Haaland, CSK,
        // Mumbai Indians, Rajasthan Royals — none of which is in the catalogue at all. That
        // breaks the NEVER INVENT PRODUCTS rule and strands the customer.
        //
        // The catalogue knows the answer exactly, so nothing is gained by asking a model:
        // listTeams() reads it straight from the in-stock products cache.
        if (woocommerceService.asksWhichTeams(userQuery)) {
          const reply = this.teamListReply(session.language, session);
          if (reply) {
            session.history.push({ role: 'user', content: userQuery });
            session.history.push({ role: 'assistant', content: reply });
            await this._saveSession(senderId, session);
            return { replyText: reply, intent: 'deterministic_teams', requiresEscalation: false, suggestedProductIds: [] };
          }
        }

        // --- Guided browse, step 1: "what do you actually sell?" ---
        // Runs AFTER the teams check on purpose. "Enna enna team la iruke?" satisfies both, and
        // a question about teams deserves the team list -- this is the broader case, where the
        // customer has not seen the shop and cannot name anything to ask for.
        if (woocommerceService.asksWhatWeSell(userQuery)) {
          const reply = this.browseMenuReply(session.language, session);
          if (reply) {
            session.history.push({ role: 'user', content: userQuery });
            session.history.push({ role: 'assistant', content: reply });
            await this._saveSession(senderId, session);
            return { replyText: reply, intent: 'deterministic_browse', requiresEscalation: false, suggestedProductIds: [] };
          }
        }

        // --- Deterministic "I can't understand you" recovery (added 2026-09-22) ---
        // "Enna bro pesuradhe purila" ("I don't get what you're saying") is the clearest
        // possible signal that the previous reply's Tanglish did not land — and in the
        // 2026-09-21 chat the model answered it with MORE of the same invented Tamil
        // ("Oru team pechu sollu"), which is the worst available move.
        //
        // Handled in code because the recovery must not be generated by the thing that just
        // failed: apologise once, then say it again in mostly plain English with the actual
        // catalogue in front of them, so the next turn has something concrete to reply to.
        if (/\b(purila|puriyala|puriyalai|puriyathu|puriyavillai|puriyala\s*bro|enna\s+sollur[ae]|enna\s+solringa|what\s+are\s+you\s+saying|makes?\s+no\s+sense|didn'?t\s+understand|don'?t\s+understand|not\s+clear)\b/i.test(userQuery)) {
          const teams = woocommerceService.listTeams(8);
          const list = teams.length > 0 ? `\n\n${teams.map(t => `• ${t}`).join('\n')}\n` : ' ';
          const reply = session.language === 'tanglish'
            ? `Sorry 🙏 simple ah solren. Namma stock la idhellaam iruku:${list}\nOru team name type pannunga (example: "Real Madrid") — naan price, size ellaam anuppuren.`
            : `Sorry about that! 🙏 Let me keep it simple. Here's what we have in stock:${list}\nJust type one team name (for example "Real Madrid") and I'll send you the price and sizes.`;
          session.history.push({ role: 'user', content: userQuery });
          session.history.push({ role: 'assistant', content: reply });
          await this._saveSession(senderId, session);
          return { replyText: reply, intent: 'deterministic_clarify', requiresEscalation: false, suggestedProductIds: [] };
        }
        // Skip the canned FAQ fast-path for real order-tracking lookups and complaints so
        // they reach the LLM support agent (which can call lookup_order / create_support_ticket)
        // instead of being intercepted by a generic policy blurb. A bare "how do I track?"
        // (no order number) still gets the cheap FAQ answer.
        const looksLikeOrderLookup = /\b(order|parcel|package|shipment|tracking|track|delivered|delivery|status)\b/i.test(userQuery) && /\d{3,}/.test(userQuery);
        const looksLikeComplaint = /\b(wrong (item|jersey|name|number|size|team|product)|damaged|broken|defective|torn|stained|misprint|missing|not received|didn'?t (get|receive)|never (got|arrived|received)|haven'?t received)\b/i.test(userQuery);
        // Refund/money-back is a sensitive money topic — route it to the LLM so it collects the
        // order details and raises a ticket (never a canned blurb, and never a refund promise).
        // The owner's 2026-09-28 guide: no return/exchange policy is stated; the team decides.
        const looksLikeRefund = /\b(refund|money back|cashback|return my money|my money back)\b/i.test(userQuery);

        // An FAQ answer whose numbers (price, days, phone) are not in the owner's rule cards on
        // that topic is never served — the question goes to the agent, which gets those cards
        // with the message (services/rules.js). An FAQ that agrees stays free.
        await rulesService.refresh();
        const overridden = rulesService.disabledFaqCategories();
        // An FAQ answers ONE thing. "FC set la shorts varuma? size M irukka" used to get the
        // FC Set answer and the size question was silently dropped — so a Tanglish message
        // with two or more questions goes to the agent, which is told to answer each in turn.
        const asksSeveral = session.language === 'tanglish' && tanglishReader.questionsIn(userQuery).length >= 2;
        const faqMatches = (looksLikeOrderLookup || looksLikeComplaint || looksLikeRefund || asksSeveral) ? []
          : faqService.searchFAQs(userQuery).filter(f => !overridden.has(f.category));
        if (faqMatches.length > 0) {
          // Language-matched reply — session.language is already locked, and answering a
          // Tanglish customer in English here would contradict the whole conversation.
          const answer = faqService.answerFor(faqMatches[0], session.language);
          session.history.push({ role: 'user', content: userQuery });
          session.history.push({ role: 'assistant', content: answer });
          await this._saveSession(senderId, session);
          return { replyText: answer, intent: 'faq', requiresEscalation: false, suggestedProductIds: [] };
        }
      }
    }

    // (The old size+qty / bare-selection regex fast paths lived here. They defaulted an
    // unidentified product to #1 and read a leading product number as the quantity — the
    // Guardiola-instead-of-Messi bug. _handleOrderStateTurn replaces both.)

    // --- Deterministic order-confirmation bypass ---
    // Only short-circuits on a message that IS ENTIRELY a confirmation word/phrase —
    // anchored full-string match, not substring — so "yes but change the address"
    // still goes to the LLM instead of confirming blindly.
    if (session.state === 'CONFIRMING_ORDER' && userQuery) {
      // Understood: the verdict decides. Not understood: the old full-string word match.
      const isConfirmReply = verdict ? forceConfirm : /^\s*(yes+|yeah|yep|ye+p|confirm(ed)?|ok(ay)?|okey|sure|correct|right|seri|sari|proceed|go ahead|order pannunga|book pannunga|place (the )?order)\s*[!.]*\s*$/i.test(userQuery.trim());
      if (isConfirmReply) {
        const result = await this._confirmOrderNow(session, senderId);
        // WooCommerce refused the order (or ordering is known to be down). Say so honestly,
        // keep the cart, alert the owner -- never send a confirmation for an order that does
        // not exist. See _handleOrderFailure for the full history of why.
        if (result.ok && !result.created) {
          return await this._handleOrderFailure(senderId, session, userQuery, result);
        }
        if (result.ok) {
          const isTanglish = session.language === 'tanglish';
          // Methods come from config.payment, never hard-coded — see _paymentReply.
          const payMethods = (config.payment?.methods || []).join(' / ');
          // The order ID and the payment link are printed ONLY when WooCommerce actually
          // returned them -- we are past `created`, so the ID is real either way.
          // Unpaid orders are cancelled by WooCommerce after holdMinutes, so say so: "confirmed"
          // alone read as done, and nobody knew the link would die (2026-10-01).
          const hold = config.payment?.holdMinutes || 60;
          const holdText = hold % 60 === 0 ? `${hold / 60} ${hold === 60 ? 'hour' : 'hours'}` : `${hold} minutes`;
          const reply = result.checkoutUrl
            ? (isTanglish
                ? `Super! 🎉 Order #${result.orderId} place aayiduchu! Idha click pannunga pay pannurathukku: ${result.checkoutUrl}${payMethods ? `\n${payMethods} la pay pannunga.` : ''}\n⏳ ${holdText} kulla pay pannunga — illana order auto-cancel aagidum. Thanks for shopping with Theaurax! ⚽🔥`
                : `Awesome! 🎉 Your order #${result.orderId} is placed! Tap here to complete payment: ${result.checkoutUrl}${payMethods ? `\nPay by ${payMethods}.` : ''}\n⏳ Please pay within ${holdText} — unpaid orders are cancelled automatically. Thanks for shopping with Theaurax! ⚽🔥`)
            : (isTanglish
                ? `Super! 🎉 Order #${result.orderId} place aayiduchu! Payment link konja neram la inga anuppuren — team confirm panniduvaanga. Thanks! ⚽🔥`
                : `Great news! 🎉 Your order #${result.orderId} has been placed! I'll send your payment link here shortly — our team is confirming it now. Thanks for shopping with Theaurax! ⚽🔥`);

          const cartSnapshot = session.cart;
          // A real order with no payment link still needs a human to send one. There is no
          // proforma PDF here any more: an invoice with no way to pay reads as a completed
          // purchase, which is precisely what made the old false confirmation convincing.
          if (!result.checkoutUrl) {
            this.sendOrderFailureAlert(senderId, session, {
              error: `Order #${result.orderId} was created but WooCommerce returned no payment link — send the customer one manually.`
            }, null);
          }

          session.history.push({ role: 'user', content: userQuery });
          session.history.push({ role: 'assistant', content: reply });
          // Remember the order (so "how pay?" afterwards returns THIS link) and the address
          // (so the next order can say "same address"), then clear the per-order state.
          session.lastOrder = {
            orderId: result.orderId, checkoutUrl: result.checkoutUrl || null, at: Date.now(),
            // Kept so an order that expires unpaid can be placed again with one "YES".
            items: (cartSnapshot || []).map(i => ({ productId: i.productId, name: i.name, price: i.price, size: i.size, qty: i.qty })),
          };
          if (session.addressDetails) session.customerProfile = { ...session.addressDetails };
          this._clearOrderSelection(session);
          session.lastShownProducts = [];
          session.address = null;
          session.addressDetails = null;
          session.addressDraft = null;
          // Keep ONLY the confirmation exchange. Wiping everything (as before 2026-09-30) made
          // "Epo delivery aagum?" one minute later look like a stranger's first message, and it
          // got the team list and "will you place the order?". The old product talk is still
          // dropped, so a stale productId cannot leak into the next order.
          session.history = session.history.slice(-2);

          await this._saveSession(senderId, session);
          await dbService.saveLead({
            userId: senderId,
            name: session.customerName || 'Customer',
            phone: senderId.replace(/[^0-9]/g, ''),
            channel: 'whatsapp',
            cart: cartSnapshot,
            address: null,
            requiresEscalation: false,
            status: 'completed',
            conversation: []
          });

          return { replyText: reply, intent: 'deterministic_confirm', requiresEscalation: false, suggestedProductIds: [] };
        }
        // Cart failed validation (empty/corrupt) — fall through to the LLM to explain why.
      }
    }

    await rulesService.refresh(); // generateSystemPrompt + contextFor read the Rule Book synchronously
    let messages = [
      { role: "system", content: this.generateSystemPrompt(session) }
    ];

    for (const msg of session.history) {
      messages.push({ role: msg.role, content: msg.content || "" });
    }

    // --- Knowledge Hub context injection ---
    // If the client has taught the bot something relevant to this query (but not a
    // confident-enough match to answer deterministically above), inject it as a
    // high-priority system note so the LLM prefers it over its own guess. Kept as a
    // SEPARATE message (not folded into generateSystemPrompt) so the main system prompt
    // stays a stable, cacheable prefix, and placed right before the user's message so it's
    // adjacent to it and survives token-budget trimming. Zero cost when there's no match.
    try {
      const knowledgeHit = await knowledgeService.match(userQuery, session.language);
      if (knowledgeHit) {
        const e = knowledgeHit.entry;
        messages.push({
          role: 'system',
          content: `VERIFIED BUSINESS KNOWLEDGE (provided by the store owner — treat this as the source of truth and prefer it over your own guess when it answers the customer's current question):\nQ: ${e.question || (e.keywords || []).join(', ')}\nA: ${e.answer}`
        });
      }
    } catch (err) {
      console.warn('[AI Service] Knowledge injection skipped:', err.message);
    }

    // --- Knowledge SOURCE retrieval (uploaded documents + crawled website) ---
    // Same placement rationale as the Q&A injection above: a separate system message
    // right before the user's turn, so the cacheable system-prompt prefix stays intact
    // and this survives token trimming. Deliberately AFTER the Q&A injection — a
    // hand-written answer from the owner is more authoritative than a document excerpt.
    //
    // Costs nothing when no documents are indexed (retrieval short-circuits on an empty
    // chunk set), and this runs only on the LLM path — the deterministic fast paths
    // (FAQ, confident Q&A match, size/qty parsing, order confirmation) return before
    // reaching here and stay zero-latency.
    // --- Owner's Rule Book (services/rules.js) ---
    // The rule cards from the owner's documents that are about THIS message's topic. Placed
    // after the Q&A note and before any website excerpt: a hand-typed answer is the most
    // specific, the owner's documents come next, crawled pages last. Chosen by the bilingual
    // topic word list in code — no AI call, no embedding — and nothing when no topic matches.
    try {
      const prevUser = [...session.history].reverse().find(m => m.role === 'user')?.content || '';
      const ruleContext = rulesService.contextFor(userQuery, prevUser);
      if (ruleContext) {
        const { _count, ...message } = ruleContext;
        messages.push(message);
        console.log(`[Rules] Injected ${_count} owner rule card(s) into context`);
      }
    } catch (err) {
      console.warn('[AI Service] Rule Book injection skipped:', err.message);
    }

    try {
      const contextMessage = await retrievalService.buildContextMessage(userQuery);
      if (contextMessage) {
        const { _hits, ...message } = contextMessage;
        messages.push(message);
        console.log(`[Knowledge] Injected ${_hits} document chunk(s) into context`);
      }
    } catch (err) {
      console.warn('[AI Service] Knowledge source retrieval skipped:', err.message);
    }

    // --- Tanglish, read in code (services/tanglish.js) ---
    // The customer's words with each Tamil word's English meaning attached, and their
    // questions counted, so the model decides from the meaning instead of guessing at the
    // spelling. Right before the message, like the notes above. Tanglish only: English
    // replies are already logical, and the note would only cost tokens there.
    const orderActiveNow = orderState.hasActiveOrder(session);
    let thinkThisTurn = false;
    if (session.language === 'tanglish') {
      const note = tanglishReader.readingNote(userQuery);
      if (note) messages.push({ role: 'system', content: note });
      thinkThisTurn = tanglishReader.isHard(userQuery, { orderActive: orderActiveNow });
      if (thinkThisTurn) console.log('[AI Service] Hard Tanglish message — letting the model think this turn');
    }

    // The meaning from the understanding step, right before the message it explains.
    if (agentNote) messages.push({ role: 'system', content: agentNote });

    messages.push({ role: "user", content: userQuery });

    let keepLooping = true;
    let loops = 0;
    let forcedSearchRetryDone = false;
    let stateRetryDone = false;
    let lastSearchResults = null;

    while (keepLooping && loops < 5) {
      loops++;
      try {
        const completion = await this.callLLMWithFallback(messages, session.language, senderId, { think: thinkThisTurn });

        const responseMessage = completion.choices[0].message;
        
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          // Two-pass stripping: when the model outputs BOTH a tool call and conversational text
          // in the same turn, the text is a leaked artifact that must be discarded.
          // Only the tool call should be processed — the natural reply comes in the next loop iteration.
          if (responseMessage.content) {
            console.warn('[AI Service] Groq leaked text alongside tool call — stripping content:', responseMessage.content.slice(0, 80));
            responseMessage.content = "";
          }
          messages.push(responseMessage);
          
          for (const toolCall of responseMessage.tool_calls) {
            const fnName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            let toolResultObj = {};

            if (fnName === "search_products") {
              // Carry the team/player from the previous search when this query is nothing but
              // constraints ("player version 26/27"), then search with those constraints
              // applied as real filters rather than as tokens that get silently dropped.
              const searchQuery = this._mergeSearchContext(session, args.query || "");
              const found = woocommerceService.searchProductsDetailed(searchQuery);
              searchRanThisTurn = true;
              // Captured before this search overwrites it — see the 'broad' follow-up below.
              const previouslyShown = Array.isArray(session.lastShownProducts) ? session.lastShownProducts : [];
              // `shown` is what the customer will actually see. On a miss that is a list of
              // generic suggestions, and every message built from it says so.
              const shown = found.products.length > 0 ? found.products : found.suggestions;
              matchedProductIds = shown.map(p => p.id);
              lastSearchResults = shown;
              // Persisted so a later turn (e.g. "1st one, M size 2") can resolve which
              // product the customer means without an LLM call — see parseSizeQtyReply.
              session.lastShownProducts = shown.slice(0, 10).map(p => ({
                productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: p.permalink || ''
              }));
              // A fresh search invalidates any earlier "customer picked #2" memory —
              // that index referred to the OLD list. It does NOT touch the locked product
              // or the cart: showing options is not the customer choosing one.
              session.pendingProductIndex = null;
              session.productListPending = shown.length > 0;
              if (found.products.length > 0) session.lastListContext = { type: 'search', query: searchQuery };

              // Skip the second "narration" LLM call entirely — template it directly.
              // Originally only did this for a single confident match; multi-match search
              // results were left to the LLM to narrate, which proved unreliable (Llama-3.3
              // on Groq would repeat the "which size?" question after every single product
              // instead of asking once at the end, and vary the list format turn to turn).
              // Templating deterministically for 1-3 matches guarantees correct formatting,
              // a numbered list customers can reply to ("1st one"), and saves an LLM turn.
              if (shown.length >= 1 && responseMessage.tool_calls.length === 1) {
                const top = shown.slice(0, 3);
                const isTanglish = session.language === 'tanglish';

                // 'broad' means the customer has not named anything to search on yet, so
                // there is nothing to list -- the blocker is the missing team, not the
                // product. Answer it the same way the deterministic "which teams?" path
                // does: from the catalogue, so the list is real.
                // Mid-order, a vague search must NOT throw the customer back to team selection
                // (the "Idhellaam ippo stock la iruku bro … Enna team venum?" regression):
                // resume their order instead.
                // The customer did not ask to see products (a delivery question, "okay", "no
                // need"…) but the model searched anyway, found no team, and until 2026-09-30 the
                // code below then REPLACED their question with the team list or the cart prompt.
                // Hand the question back to the model instead.
                // Same when the message could not be read at all but the customer is mid-order
                // or just had a cart removed: a vague search then is about THAT order, and the
                // team list is the one reply that is certainly wrong (2026-10-01, three times).
                const unreadMidOrder = !verdict && (orderState.hasActiveOrder(session) || this._recentlyRemovedCart(session));
                if (found.matchQuality === 'broad' && (unreadMidOrder || (verdict
                    && !['product_search', 'list_teams', 'list_more', 'browse_catalogue'].includes(verdict.intent)))) {
                  session.lastShownProducts = previouslyShown;
                  lastSearchResults = [];
                  matchedProductIds = [];
                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: fnName,
                    content: JSON.stringify({
                      products: null,
                      matchQuality: 'not_a_product_request',
                      message: verdict
                        ? `The customer did not ask for products. Their meaning: ${verdict.meaning || verdict.intent}. Answer that directly and briefly. Do not search again and do not list teams or products.`
                        : 'The customer is in the middle of an order (or just had one removed) and did not name a new team. Answer what they asked about that order directly and briefly. Do not search again and do not list teams or products.',
                    }),
                  });
                  continue;
                }
                if (found.matchQuality === 'broad' && orderState.hasActiveOrder(session)) {
                  session.lastShownProducts = [];
                  session.productListPending = false;
                  lastSearchResults = [];
                  matchedProductIds = [];
                  resultText = this._nextStepPrompt(session);
                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: fnName,
                    content: JSON.stringify({ products: null, matchQuality: 'broad', message: 'Active order in progress — resumed it instead of listing teams.' })
                  });
                  keepLooping = false;
                  break;
                }
                // A follow-up about products that are ALREADY on screen ("price konjam kammi
                // pannunga", "discount iruka?", "quality eppadi?") names no team, so the model's
                // search comes back 'broad'. Answering that with the team list threw the customer
                // back to square one mid-conversation (seen live 2026-09-28). Keep the list they
                // were looking at and let the model answer the actual question about it.
                if (found.matchQuality === 'broad' && previouslyShown.length > 0) {
                  session.lastShownProducts = previouslyShown;
                  session.productListPending = true;
                  lastSearchResults = [];
                  matchedProductIds = [];
                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: fnName,
                    content: JSON.stringify({
                      products: previouslyShown.slice(0, 3).map(p => ({ name: p.name, price: p.price, sizes: p.sizes })),
                      matchQuality: 'already_shown',
                      message: 'No new team or product was named — the customer is asking about the products already shown. Answer their question about these directly and briefly. Prices are fixed: no discounts or offers. Do not search again and do not list teams.'
                    })
                  });
                  continue;
                }
                if (found.matchQuality === 'broad' && this.teamListReply(session.language, session)) {
                  // Nothing was shown, so a later "1st one" must not resolve against the
                  // suggestions list the customer never saw.
                  session.lastShownProducts = [];
                  lastSearchResults = [];
                  matchedProductIds = [];
                  resultText = this.teamListReply(session.language, session);
                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: fnName,
                    content: JSON.stringify({ products: null, matchQuality: 'broad', message: this._searchResultMessage(found, searchQuery) })
                  });
                  keepLooping = false;
                  break;
                }

                // What we could NOT give them comes FIRST, ahead of any hype. Until 2026-09-21
                // the hype opener was unconditional, so "Semma choice bro! 😍" was printed over
                // the five cheapest in-stock shirts when the search had found nothing at all --
                // the single biggest reason the 2026-09-20 tester reviews read as the bot faking
                // a match. Hype is now reserved for a genuine, fully-constrained hit.
                let opener;
                if (found.matchQuality === 'none') {
                  opener = isTanglish
                    ? `Sorry, "${searchQuery}" ku exact ah kidaikala 😕 Idhu namma popular collection \u2014 paarunga:`
                    : `Sorry, I couldn't find an exact match for "${searchQuery}" 😕 Here are some popular ones instead:`;
                } else if (found.matchQuality === 'partial') {
                  const miss = found.unmatched.join(' / ');
                  opener = isTanglish
                    ? `Bro, ${miss} ippo stock la illa 😕 Aana idhellaam iruku, paarunga:`
                    : `We don't have ${miss} in stock right now 😕 Here's what we do have:`;
                } else {
                  const hypeOpeners = isTanglish
                    ? ['Iruku! Idho options 👇', 'Kandippa iruku 👇', 'Idho ippo available ah irukkuradhu 👇']
                    : ['Yes, we have it! 🔥', 'Great pick! 😍', 'This one\'s a favorite! 🏆'];
                  opener = hypeOpeners[Math.floor(Math.random() * hypeOpeners.length)];
                }

                if (top.length === 1 && found.matchQuality === 'exact') {
                  const p = top[0];
                  const sizeText = p.sizes && p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : '';
                  resultText = isTanglish
                    ? `${opener} *${p.name}* — ₹${p.price} la kedaikuthu!${sizeText}\n${p.permalink || ''}\n\nEnna size venum, enna quantity venum? 🛍️`
                    : `${opener} *${p.name}* — ₹${p.price}${sizeText}\n${p.permalink || ''}\n\nWhich size and how many would you like? 🛍️`;
                } else {
                  const lines = top.map((p, i) => {
                    const sizeText = p.sizes && p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : '';
                    return `${i + 1}. *${p.name}* — ₹${p.price}${sizeText}${p.permalink ? `\n${p.permalink}` : ''}`;
                  }).join('\n');
                  resultText = isTanglish
                    ? `${opener}\n${lines}\n\nEdhu venum — ${pickRange(top.length, true)}? Enna size, evlo quantity venum? 🛍️`
                    : `${opener}\n${lines}\n\nWhich one would you like — ${pickRange(top.length, false)}? What size and how many? 🛍️`;
                }

                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: fnName,
                  content: JSON.stringify({ products: shown, matchQuality: found.matchQuality, unmatched: found.unmatched, message: this._searchResultMessage(found, searchQuery) })
                });
                keepLooping = false;
                break;
              }

              toolResultObj = {
                products: shown.length > 0 ? shown : null,
                matchQuality: found.matchQuality,
                unmatched: found.unmatched,
                message: this._searchResultMessage(found, searchQuery),
              };
            } else if (fnName === "update_cart") {
              // Re-derive the product from a trusted source (the list shown to this
              // customer, then the cache) instead of trusting the LLM's raw productId,
              // which can be stale/mismatched vs the name+price it displayed — that
              // silently orders/charges a DIFFERENT product. See resolveCartProduct().
              const resolved = this.resolveCartProduct(args, session);
              if (resolved && String(resolved.productId) !== String(args.productId)) {
                console.warn(`[AI Service] update_cart productId corrected: LLM sent ${args.productId} ("${args.name}") → resolved to ${resolved.productId} ("${resolved.name}") ₹${resolved.price}`);
              } else if (!resolved) {
                console.warn(`[AI Service] update_cart could not resolve product (id=${args.productId}, name="${args.name}") against shown list/cache — using raw args.`);
              }
              let chosen = resolved || { productId: args.productId, name: args.name, price: args.price };

              // PRODUCT LOCK. Once the customer has picked a product, the model may not swap
              // it — not for a "more similar" search hit, not for a product from earlier
              // history. Only the customer's own words can: an explicit change request, or a
              // message that actually names the new product.
              const locked = orderState.lockedProduct(session);
              const ents = orderState.extractEntities(userQuery, {
                shownCount: (session.lastShownProducts || []).length,
                awaiting: this._awaiting(session),
                hasSelection: Boolean(locked),
              });
              if (locked && String(chosen.productId) !== String(locked.productId)
                  && !ents.changeProduct && !this._customerNamedProduct(userQuery, chosen, locked)) {
                console.warn(`[AI Service] update_cart BLOCKED product swap for ${senderId}: model sent "${chosen.name}" (${chosen.productId}) but the customer's locked product is "${locked.name}" (${locked.productId}). Keeping the locked product.`);
                chosen = { productId: locked.productId, name: locked.name, price: locked.price };
              }

              // Size and quantity also come from the customer's words first. The model's value
              // is used only when this message didn't state one AND nothing is stored yet, or
              // when the number it sent actually appears in the customer's message.
              const current = session.cart?.[0] || {};
              const mentions = (n) => n != null && new RegExp(`(?<!\\d)${parseInt(n, 10)}(?!\\d)`).test(userQuery);
              const size = (ents.size && (ents.sizeConfident || !current.size)) ? ents.size
                : (current.size || session.pendingSize || args.size);
              const qty = ents.qty
                || (mentions(args.qty) ? parseInt(args.qty, 10) : null)
                || current.qty || session.pendingQty || parseInt(args.qty, 10) || 1;
              const chosenFull = (session.lastShownProducts || []).find(p => String(p.productId) === String(chosen.productId))
                || (String(locked?.productId) === String(chosen.productId) ? locked : null)
                || chosen;

              if (size && !orderState.productHasSize(chosenFull, String(size).toUpperCase())) {
                toolResultObj = { status: "error", message: `Size ${size} is not available for ${chosen.name}. Available sizes: ${(chosenFull.sizes || []).join(', ')}. Ask the customer to pick one of those. Do NOT change the product.` };
              } else {
                this._lockProduct(session, { ...chosenFull, ...chosen });
                session.cart = [{
                  productId: chosen.productId,
                  name: chosen.name,
                  price: chosen.price,
                  size: String(size || '').toUpperCase(),
                  qty
                }];
                session.pendingSize = null;
                session.pendingQty = null;
                session.state = 'COLLECTING_ADDRESS';
                const known = this._knownAddress(session);
                if (orderState.isAddressComplete(known)) {
                  // Their details are already on file — never ask again. Go to the summary.
                  const res = this._applyAddress(senderId, session, known);
                  if (res.bulk) {
                    requiresEscalation = true;
                    toolResultObj = { status: "success", message: `CRITICAL: Cart quantity is ${res.totalQty}, which is a bulk order. DO NOT ask to confirm order. Tell the user our wholesale team will reach out to them shortly.` };
                  } else {
                    resultText = this._summaryReply(session);
                    messages.push({ role: "tool", tool_call_id: toolCall.id, name: fnName, content: JSON.stringify({ status: "success" }) });
                    keepLooping = false;
                    break;
                  }
                } else {
                  const missing = orderState.missingAddressFields(known);
                  toolResultObj = {
                    status: "success",
                    message: `Cart updated: ${chosen.name}, size ${session.cart[0].size}, qty ${qty}. `
                      + `Ask the customer ONLY for these missing shipping details: ${missing.join(', ')}. Do not ask for anything else.`
                  };
                }
              }
            } else if (fnName === "set_shipping_address") {
              // Some models emit phone/pincode as bare JSON numbers — normalize to strings.
              // The model's values are MERGED over what we already hold (never replace a
              // known field with a blank), and nothing is accepted until every field is valid.
              const merged = orderState.mergeAddress(this._knownAddress(session), {
                name: args.name && args.name !== 'Customer' ? String(args.name) : '',
                phone: String(args.phone ?? '').replace(/\D/g, '').slice(-10),
                address: args.address ? String(args.address) : '',
                pincode: String(args.pincode ?? '').replace(/\D/g, ''),
              });
              session.addressDraft = merged;
              const missing = orderState.missingAddressFields(merged);

              if (!session.cart || session.cart.length === 0) {
                toolResultObj = { status: "error", message: "The cart is empty, so there is nothing to ship yet. Details were saved. Ask which jersey, size and quantity they want." };
              } else if (missing.length > 0) {
                toolResultObj = { status: "error", message: `Shipping details incomplete. Still missing: ${missing.join(', ')}. Ask the customer ONLY for those — everything else is already saved.` };
              } else {
                const res = this._applyAddress(senderId, session, merged);
                if (res.bulk) {
                  requiresEscalation = true;
                  toolResultObj = { status: "success", message: `CRITICAL: Cart quantity is ${res.totalQty}, which is a bulk order. DO NOT ask to confirm order. Tell the user our wholesale team will reach out to them shortly.` };
                } else {
                  // Template the order summary deterministically from session.cart instead
                  // of letting the LLM narrate it — narration was observed fabricating a
                  // second line item from earlier history. Money-facing totals shouldn't
                  // depend on the model reading its own context correctly.
                  resultText = this._summaryReply(session);
                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: fnName,
                    content: JSON.stringify({ status: "success", message: "Address saved." })
                  });
                  keepLooping = false;
                  break;
                }
              }
            } else if (fnName === "escalate_to_human") {
              this._markSideEffect(senderId);
              requiresEscalation = true;
              session.requiresEscalation = true;
              session.state = 'IDLE';
              session.escalationDetails = {
                reason: args.reason,
                name: args.customerName,
                phone: String(args.customerPhone ?? ''),
                address: args.customerAddress
              };
              toolResultObj = { status: "success", message: "Escalated. Tell the user our wholesale/support team will reach out to them shortly." };
            } else if (fnName === "confirm_order") {
              if (!session.cart || session.cart.length === 0) {
                toolResultObj = { status: "error", message: "Cart is empty. Do NOT create an order. Ask the customer which jersey, size, and quantity they want first." };
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: fnName,
                  content: JSON.stringify(toolResultObj)
                });
                continue;
              }

              const invalidItem = session.cart.find(item =>
                !item.name || !item.price || isNaN(parseFloat(item.price)) || parseFloat(item.price) <= 0
              );
              if (invalidItem) {
                console.warn(`[AI Service] Rejected confirm_order for ${senderId} — corrupted cart item:`, JSON.stringify(invalidItem));
                session.cart = [];
                session.state = 'IDLE';
                toolResultObj = { status: "error", message: "Cart data is incomplete (missing product name or price). Do NOT create an order. Ask the customer to tell you again which jersey, size, and quantity they want." };
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: fnName,
                  content: JSON.stringify(toolResultObj)
                });
                continue;
              }

              // State gate: an order is only created from CART_REVIEW with complete shipping
              // details and a message that actually confirms. The model deciding "it's time"
              // is not enough — it once confirmed on a message that was really a correction.
              const missingAddr = orderState.missingAddressFields(session.addressDetails || this._knownAddress(session));
              const saysYes = /\b(yes|yeah|yep|confirm|confirmed|ok|okay|okey|sure|seri|sari|proceed|place|book|done)\b/i.test(userQuery)
                && !/\b(no|not|illa|wait|change|maathu|vendam|cancel)\b/i.test(userQuery);
              if (missingAddr.length > 0 || session.state !== 'CONFIRMING_ORDER' || !saysYes) {
                toolResultObj = {
                  status: "error",
                  message: missingAddr.length > 0
                    ? `Cannot place the order yet — shipping details missing: ${missingAddr.join(', ')}. Ask ONLY for those.`
                    : "Cannot place the order — the customer has not confirmed the summary. Show nothing new; ask them to reply YES to confirm the order summary.",
                };
                messages.push({ role: "tool", tool_call_id: toolCall.id, name: fnName, content: JSON.stringify(toolResultObj) });
                continue;
              }

              const addrDetails = session.addressDetails;
              const payMethods = (config.payment?.methods || []).join(', ');
              this._markSideEffect(senderId);

              // Ordering is known to be down -- don't place the customer in a dead end.
              const orderResult = woocommerceService.orderingAvailable === false
                ? { success: false, error: woocommerceService.orderingError || 'WooCommerce ordering unavailable' }
                : await woocommerceService.createOrder(session.cart, addrDetails, session.customerName);

              // `isConfirmed` is what wipes the cart, address and history further down, so it
              // is set ONLY once a real order ID exists. It used to be set before the call ran.
              if (orderResult.success && orderResult.orderId) {
                isConfirmed = true;
                session.state = 'IDLE';
                checkoutUrl = orderResult.paymentUrl;
                // Remember this order so the customer can track it here later regardless of
                // which phone they entered vs. their WhatsApp number (see lookup_order).
                if (orderResult.orderId) {
                  session.orderIds = session.orderIds || [];
                  if (!session.orderIds.map(String).includes(String(orderResult.orderId))) {
                    session.orderIds.push(String(orderResult.orderId));
                  }
                }
                toolResultObj = {
                  status: "success",
                  orderId: orderResult.orderId,
                  paymentUrl: checkoutUrl,
                  message: `Order #${orderResult.orderId} created! Share this payment link with the customer so they can complete checkout: ${checkoutUrl}. Tell them to tap the link and pay${payMethods ? ` (accepted: ${payMethods})` : ''} — name no other payment method. Be warm and enthusiastic!`
                };
              } else {
                // status MUST be "error". It said "success" / "Order noted manually" until
                // 2026-09-21, so the model warmly confirmed an order that never existed while
                // the code below wiped the cart. Keep the cart, keep CONFIRMING_ORDER, and
                // tell the model in no uncertain terms what it may not say.
                const ticket = await this._recordOrderFailure(senderId, session, {
                  error: orderResult.error || 'WooCommerce did not return an order'
                });
                toolResultObj = {
                  status: "error",
                  message: "The order could NOT be created — a technical failure on our side. "
                    + "Tell the customer plainly that it did NOT go through, that they have NOT been charged, "
                    + "that their cart is saved, and that our team has been alerted and will contact them shortly. "
                    + "Invite them to reply 'yes' again in a few minutes so you can retry. "
                    + (ticket ? `Give them the reference ${ticket.id}. ` : '')
                    + "Do NOT thank them for their order, do NOT say it is confirmed or placed, "
                    + "do NOT invent an order ID, and do NOT give a payment link. Apologise once, warmly, and be brief."
                };
              }
            } else if (fnName === "lookup_order") {
              const res = await woocommerceService.getOrder(args.orderId);
              if (res.success) {
                // Privacy guard: an order ID alone must NOT expose another customer's
                // order. Only reveal details if the requester's WhatsApp number matches
                // the order's billing phone (WooCommerce IDs are sequential/guessable).
                const sessionPhone = (session.customerPhone || senderId.replace(/\D/g, '')).slice(-10);
                // A customer can always track an order THEY placed in this chat — we created
                // it here, so ownership is already established. Without this, entering a
                // delivery/family phone that differs from their WhatsApp number (common) locks
                // them out of tracking their own just-placed order.
                const placedHere = (session.orderIds || []).map(String).includes(String(res.order.id));
                const owns = placedHere || (res.order.billingPhone && sessionPhone && res.order.billingPhone === sessionPhone);
                if (res.order.billingPhone && !owns) {
                  toolResultObj = { status: "not_authorized", message: `Order #${res.order.id} is not linked to this WhatsApp number, so its details can't be shared here (customer privacy). Politely ask the customer to message from the number used to place the order, or offer to raise a support ticket so the team can verify and help.` };
                } else {
                  const o = res.order;
                  const itemsText = o.items.map(i => `${i.name}${i.size ? ' (Size ' + i.size + ')' : ''} x${i.qty}`).join(', ');
                  toolResultObj = {
                    status: "found",
                    order: {
                      id: o.id, status: o.statusLabel, placed: o.dateCreated,
                      total: `${o.currency} ${o.total}`, items: itemsText,
                      tracking: o.trackingNumber || null, trackingUrl: o.trackingUrl || null
                    },
                    message: `Share this order's status warmly and clearly. ${o.trackingNumber ? 'Give the tracking number/link to the customer.' : 'There is NO tracking number yet — do NOT invent one; if it is still being prepared, reassure them it will ship soon.'} If the customer is unhappy about a delay or a problem, offer to raise a support ticket.`
                  };
                }
              } else if (res.notFound) {
                toolResultObj = { status: "not_found", message: "No order found with that number. Gently ask the customer to double-check the order ID (it's in their order confirmation), or offer to raise a support ticket so the team can look it up manually." };
              } else {
                toolResultObj = { status: "error", message: "Couldn't fetch the order right now. Apologise and offer to raise a support ticket so the team can check it manually." };
              }
            } else if (fnName === "create_support_ticket") {
              this._markSideEffect(senderId);
              const ticket = await dbService.saveTicket({
                userId: senderId,
                name: args.customerName || session.customerName || 'Customer',
                phone: session.customerPhone || senderId.replace(/\D/g, ''),
                email: args.email || '',
                orderId: args.orderId || '',
                issueType: args.issueType || 'other',
                description: args.description || '',
                hasPhoto: !!session.photoReceived,
              });
              this.sendSupportTicketAlert(senderId, ticket, session);
              session.photoReceived = false; // consumed by this ticket
              session.lastTicketId = ticket.id;
              toolResultObj = {
                status: "success",
                ticketId: ticket.id,
                message: `Support ticket ${ticket.id} is created. Warmly confirm the issue is logged and the team will follow up soon. Give them the ticket reference ${ticket.id} and mention they can also email ${config.support.email} with their order ID and photos. Do NOT promise a refund or a specific resolution — only that the team will help.`
              };
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify(toolResultObj)
            });
          }
        } else {
          const rawContent = responseMessage.content || '';
          // Judge the RAW model output, never the cleaned version. Cleaning always succeeds —
          // that is the whole point of it — so a check made afterwards would report a healthy
          // reply every single time and nothing below would ever fire.
          const rawWasEmpty = !rawContent.trim();
          const rawIsCorrupted = this.looksCorrupted(rawContent);
          const languageProblems = this.tanglishProblems(rawContent, session.language);

          // The reply is cleaned HERE as well as at the egress. Not redundant: the egress
          // sanitiser is the guarantee that nothing reaches a phone, while this call is what
          // lets the rest of this block reason about, log and fall back on the real reply
          // text rather than on something still full of tool-call debris.
          resultText = this.sanitizeOutgoing(rawContent);
          if (rawIsCorrupted && !rawWasEmpty) {
            console.warn('[AI Service] Machine output leaked into a customer reply — cleaned:', rawContent.slice(0, 160));
          }
          if (languageProblems.length > 0) {
            console.warn('[AI Service] Tanglish quality problem:', languageProblems.join('; '), '|', rawContent.slice(0, 120));
          }
          const wasStrippedToGarbage = !resultText;
          if (wasStrippedToGarbage) {
            resultText = this.brokenReplyFallback(session.language);
          }

          // Guardrail: the model sometimes gives up on tool-calling (esp. after a Groq
          // tool_use_failed glitch) and sends a non-answer instead of a real reply. Known
          // shapes: (a) it recites the FAQ greeting boilerplate from the system prompt
          // verbatim, ignoring the actual question; (b) it leaks tool-call JSON, a chat
          // template tag or an escape fragment as plain text; (c) it returns nothing at all;
          // (d) it asks the customer to narrow down a jersey it never looked up; (e) it
          // writes invented Tamil. By this point the pre-AI FAQ matcher has already ruled out
          // a genuine greeting, so any of these is a failure — spend ONE regeneration on it
          // before sending the customer something we already know is wrong.
          const greetingFaq = faqService.getFAQs().find(f => f.category === 'Greetings');
          const looksLikeGreetingLeak = /welcome to theaurax\.in/i.test(resultText)
            || (greetingFaq && resultText.toLowerCase().includes(greetingFaq.question.toLowerCase()));
          const looksLikeRawJsonLeak = rawIsCorrupted && !rawWasEmpty;
          // Tester review 2026-09-20: "Ac Milan jerseys iruka bro?" was answered with "Can you
          // be more Specific" — AC Milan is in the catalogue, and no search had been run. If
          // the model wants to clarify, it has to look first.
          const askedToClarifyWithoutSearching = !searchRanThisTurn
            && /(more specific|be specific|bit specific|which team|what team|which player|which club|please specify|could you specify|enna team|entha team|konjam detail|details sollunga)/i.test(resultText)
            && woocommerceService.looksLikeProductQuery(userQuery);

          // (f) it sends the customer off to ask for a team we do not carry. Seen twice:
          // "IPL team ah irundha CSK, Mumbai Indians, Rajasthan Royals kooda iruku" on
          // 2026-09-21, and "say PSG, Real Madrid, Inter Milan" on 2026-09-22 after the
          // first round of fixes. NEVER INVENT PRODUCTS stops it naming a product it has
          // not searched; this stops it naming a whole team that will never arrive.
          const unstockedTeams = woocommerceService.unstockedTeamsMentioned(resultText);
          // (g) it quotes a price or a number of days it never read anywhere (2026-09-29).
          const badFigures = this.unsupportedFigures(resultText, [...messages, { content: userQuery }]);
          if (badFigures.length > 0) {
            console.warn(`[AI Service] Reply quotes figures found nowhere in its context: ${badFigures.join(', ')} | ${resultText.slice(0, 140)}`);
          }

          // A structural failure means the reply cannot be trusted at all. A language problem
          // means the reply is probably fine but reads badly — deliberately kept apart,
          // because the recovery for each is different (see below).
          const structuralFailure = looksLikeGreetingLeak || looksLikeRawJsonLeak
            || rawWasEmpty || askedToClarifyWithoutSearching || unstockedTeams.length > 0;
          if (structuralFailure || languageProblems.length > 0 || badFigures.length > 0) {
            if (!forcedSearchRetryDone && loops < 5) {
              forcedSearchRetryDone = true;
              messages.push({
                role: "system",
                content: looksLikeRawJsonLeak
                  ? `Your last reply contained text that was not a message for the customer. The customer's last message was: "${userQuery}". Answer it again, writing ONLY the sentences the customer should read. If you need product facts, call the search_products tool properly instead of describing it.`
                  : rawWasEmpty
                    ? `Your last reply was empty, so the customer received nothing. Their last message was: "${userQuery}". Answer it now in one or two short sentences, calling search_products first if you need product facts.`
                    : askedToClarifyWithoutSearching
                      ? `You asked the customer to be more specific without searching first. The customer's last message was: "${userQuery}" — that names something we stock. Call the search_products tool NOW with that exact query and answer from the result. Only ask a narrowing question if the search genuinely comes back with nothing.`
                      : looksLikeGreetingLeak
                        ? `You just replied with the generic welcome greeting instead of answering. The customer's last message was: "${userQuery}". Call the search_products tool now with that exact query to answer it. Do not greet again.`
                        : unstockedTeams.length > 0
                          ? `Your last reply offered the customer teams we do NOT stock: ${unstockedTeams.join(', ')}. We stock only these: ${woocommerceService.listTeams().join(', ')}. Send the answer again naming ONLY teams from that list, and never suggest a team we do not carry.`
                          : badFigures.length > 0
                            ? `Your last reply quoted ${badFigures.join(', ')} — that price or number of days is not in the product results, the store rules or this conversation. Send the answer again quoting ONLY figures that appear there. If you do not know one, say the team will confirm it.`
                            : `Your last reply used words that are not real Tamil: ${languageProblems.join('; ')}. Send the SAME answer again in natural Tanglish that a Chennai shop owner would actually type, keeping it to two short sentences. Where you are not certain a Tamil word is real, use the plain English word instead.`
              });
              continue;
            }
            // The model failed the same way twice. Only a STRUCTURAL failure justifies
            // throwing its answer away: a reply whose single fault is an odd word still
            // answers the customer's question, and the cleaned version of it is far better
            // than replacing it with an unrelated product list.
            if (structuralFailure) {
              const isTanglish = session.language === 'tanglish';
              // A reply naming teams we don't carry is asking "which one?" about a range that
              // isn't ours. The catalogue answers that exactly, so swap in the real list
              // rather than a product list the customer never asked to see.
              const teamsReply = unstockedTeams.length > 0 ? this.teamListReply(session.language, session) : null;
              if (teamsReply) {
                resultText = teamsReply;
              } else if (lastSearchResults && lastSearchResults.length > 0) {
                const top = lastSearchResults.slice(0, 3);
                const intro = isTanglish ? "Idho iruku 👇" : "Here's what we have for you! 🔥";
                const outro = isTanglish ? "Enna size venum, sollunga!" : "Which one would you like, and what size?";
                resultText = intro + "\n\n" + top.map(p =>
                  `• *${p.name}* — ₹${p.price}${p.sizes && p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : ''}${p.permalink ? `\n  ${p.permalink}` : ''}`
                ).join('\n') + "\n\n" + outro;
              } else if (this._pointedProduct(session, userQuery, null) && !(session.cart?.length)) {
                // "9 la enna la Iruku?" ended here on 10/2 — the number names a product on screen.
                resultText = this._productDetailReply(session, this._pointedProduct(session, userQuery, null));
              } else {
                resultText = isTanglish
                  ? "Andha exact jersey kidaikala — team illa player peru innoru vaati sollunga? Illa website la paarunga: https://theaurax.in"
                  : "Hmm, I couldn't find that exact jersey — could you tell me the team or player name again? Or browse the full range here: https://theaurax.in";
              }
            }
          }

          // RESPONSE VALIDATION against the authoritative order state. A reply that names a
          // different product, a different size/qty/price, re-asks for details we hold,
          // offers COD, or restarts team selection mid-order is never sent. One regeneration
          // with the state spelled out; if that fails too, a deterministic reply built from
          // the state itself.
          const stateProblems = this._validateReplyAgainstState(resultText, session, { searchRan: searchRanThisTurn });
          if (stateProblems.length > 0) {
            console.warn(`[AI Service] Reply rejected by state validation for ${senderId}: ${stateProblems.join('; ')} | ${resultText.slice(0, 140)}`);
            if (!stateRetryDone && loops < 5) {
              stateRetryDone = true;
              messages.push({
                role: "system",
                content: `Your reply was NOT sent because it contradicted the order state: ${stateProblems.join('; ')}. `
                  + `The order state in the system prompt is authoritative. Answer the customer's last message ("${userQuery}") again `
                  + `WITHOUT changing the product, size, quantity or price, WITHOUT asking for details already on file, `
                  + `and WITHOUT listing teams. If you cannot answer safely, ask one short clarification question.`
              });
              continue;
            }
            const codOnly = stateProblems.every(p => /Cash on Delivery/.test(p));
            resultText = codOnly
              ? this._paymentReply(session)
              : (this._nextStepPrompt(session) || this.brokenReplyFallback(session.language));
          }

          keepLooping = false;
        }
      } catch (err) {
        if (err.isQuotaExhausted) {
          console.warn(`[AI Service] Groq daily token quota exhausted. Will retry this message in ${Math.round(err.waitMs / 1000)}s.`);
          quotaExhaustedWaitMs = err.waitMs;
          // --- No-LLM Fallback: when all providers are exhausted, try local product cache ---
          // Mid-order, a product list would be a jump backwards — restate their order instead.
          resultText = (orderState.hasActiveOrder(session) && this._nextStepPrompt(session))
            || this._buildNoLLMFallback(userQuery, session.language);
        } else {
          console.error('[AI Service] Groq API error:', err.error ? JSON.stringify(err.error) : err.message || err);
          // No-LLM fallback for non-quota errors too — show products from local cache
          resultText = (orderState.hasActiveOrder(session) && this._nextStepPrompt(session))
            || this._buildNoLLMFallback(userQuery, session.language);
        }
        keepLooping = false;
      }
    }

    if (quotaExhaustedWaitMs !== null) {
      // Don't persist this placeholder into conversation history - schedule a real
      // re-run of the original query once the daily quota window resets instead.
      await this._saveSession(senderId, session);
      this.scheduleQuotaRetry(senderId, userQuery, customerName, customerPhone, quotaExhaustedWaitMs);
      return { replyText: resultText, intent: 'quota_exhausted', requiresEscalation: false, suggestedProductIds: [] };
    }

    // Something code already did this turn (e.g. took the old product out of the cart).
    if (notePrefix && resultText) resultText = `${notePrefix}\n${resultText}`;

    session.history.push({ role: 'user', content: userQuery });
    session.history.push({ role: 'assistant', content: resultText });

    if (isConfirmed) {
      // `isConfirmed` now means a real WooCommerce order exists, so this only wipes a session
      // whose order was genuinely placed. The proforma-PDF fallback that used to live here is
      // gone: it fired on the FAILURE path, and an official-looking invoice with no payment
      // link was the most convincing part of the false confirmation. A created order that
      // somehow has no link gets a human sent after it instead.
      if (!checkoutUrl) {
        this.sendOrderFailureAlert(senderId, session, {
          error: 'Order was created but WooCommerce returned no payment link — send the customer one manually.'
        }, null);
      }
      session.lastOrder = {
        orderId: session.orderIds?.[session.orderIds.length - 1] || null, checkoutUrl: checkoutUrl || null, at: Date.now(),
        items: (session.cart || []).map(i => ({ productId: i.productId, name: i.name, price: i.price, size: i.size, qty: i.qty })),
      };
      if (session.addressDetails) session.customerProfile = { ...session.addressDetails };
      this._clearOrderSelection(session);
      session.lastShownProducts = [];
      session.address = null;
      session.addressDetails = null;
      session.addressDraft = null;
      session.history = session.history.slice(-2);   // the confirmation exchange only — see above
    }

    if (requiresEscalation) {
      this.sendEscalationAlert(senderId, userQuery, session);
      // Reset the session so future bulk orders also trigger alerts
      this._clearOrderSelection(session);
      session.address = null;
      session.history = [];
      session.hasEscalated = false;
      session.requiresEscalation = false;
    }

    session.orderStep = orderState.computeStep(session);

    await this._saveSession(senderId, session);
    
    await dbService.saveLead({
      userId: senderId,
      name: session.customerName || customerName || 'Customer',
      phone: session.customerPhone || senderId.replace(/[^0-9]/g, ''),
      channel: 'whatsapp',
      cart: session.cart || [],
      address: session.address || null,
      requiresEscalation: session.requiresEscalation || false,
      // 'completed' only when this turn placed an order or handed it to the team. An empty
      // cart used to count too, so everyone who browsed and left — exactly who a reminder is
      // for — was marked done and never followed up (2026-10-01).
      status: isConfirmed || requiresEscalation ? 'completed' : 'active',
      conversation: session.history || []
    });

    return {
      replyText: resultText,
      intent: 'agent_handled',
      requiresEscalation: requiresEscalation,
      suggestedProductIds: matchedProductIds
    };
  }
}

const aiService = new AIService();
export default aiService;

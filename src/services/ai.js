import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config/config.js';
import faqService from './faq.js';
import knowledgeService from './knowledge.js';
import woocommerceService from './woocommerce.js';
import dbService from './db.js';
import { generateInvoicePDF } from './invoice.js';
import whatsappWebBot from './whatsapp-web-bot.js';
import telegramService from './telegram.js';
import sheetsService from './sheets.js';

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
  };
  // Round-robin cursor per provider so consecutive requests spread across keys instead
  // of every request piling onto key[0] first (which is what starves the other keys).
  static roundRobinIndex = {};

  async callWithThrottle(fn, provider = 'groq', keyIndex = 0) {
    const now = Date.now();
    const minGap = AIService.minApiGapMs[provider] || 1000;
    const timerKey = `${provider}#${keyIndex}`;
    const lastCall = AIService.lastApiCallTimes[timerKey] || 0;
    const elapsed = now - lastCall;
    if (elapsed < minGap) {
      await new Promise(r => setTimeout(r, minGap - elapsed));
    }
    AIService.lastApiCallTimes[timerKey] = Date.now();
    return fn();
  }

  constructor() {
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
    return tanglishWords.test(text) ? 'tanglish' : 'english';
  }

  generateSystemPrompt(session) {
    const isTanglish = session.language === 'tanglish';

    // Worked examples are emitted for the SESSION'S LANGUAGE ONLY. session.language is
    // deterministically decided and locked before this runs, so a Tanglish session never
    // needs the English examples and vice-versa — sending both was ~41% of the prompt for
    // no benefit. Each language block below is self-contained (product search, multi-match
    // one-question rule, verbatim payment-link rule, an FAQ) so neither loses coverage.
    const workedExamples = isTanglish
      ? `WORKED EXAMPLES — Follow these exactly:

[Tanglish] Product search + order:
  Customer: "bro chelsea jersey iruka?"
  → [Use the search_products tool with query "chelsea jersey"]
  Tool returns products.
  → Reply: "Bro kandippa iruku! 🔥 *Chelsea Home 25/26 Jersey* — ₹849 la kedaikuthu! S, M, L, XL size la iruku. Enna size venum?"
  Customer: "L bro 1 venum"
  → [Use the update_cart tool with productId:45, name:"Chelsea Home 25/26 Jersey", price:849, size:"L", qty:1]
  Tool returns success.
  → Reply: "Done bro! 🛒 Cart la potten! Ippo shipping details sollu — Name, Address, Pincode, Mobile number."

[Tanglish] Product search — multiple matches (pick top 2-3, ONE question at the end, not after each):
  Customer: "messi jersey iruka?"
  → [Use the search_products tool with query "messi jersey"]
  Tool returns 10 products.
  → Reply: "Bro kandippa iruku! 🔥 Messi jersey la ivalo options iruku:
• FC BARCELONA 2009 FINAL HOME FULL SLEEVE — MESSI — ₹470 [S, M, L, XL]
• ARGENTINA 2006 HOME — MESSI — ₹430 [S, M, L, XL]
• ARGENTINA 2026 WORLD CUP FULL SLEEVE EDITION — MESSI — ₹470 [S, M, L, XL]
Idhu top matches bro, innum options website la irukku. Ethu venum, enna size? 🤔"
  (WRONG — do NOT do this: repeating "Enna size venum?" after every single bullet. Ask it exactly once, at the very end.)

[Tanglish] Order confirmed — paying the checkout link:
  Tool (confirm_order) returns: { paymentUrl: "https://theaurax.in/checkout/order-pay/123/?pay_for_order=true&key=wc_abc" }
  → Reply: "Order confirm aayiduchi bro! 🎉 Idhu unga payment link:
https://theaurax.in/checkout/order-pay/123/?pay_for_order=true&key=wc_abc
Indha link ah open pannunga, UPI illa COD select pannunga, order confirm aayidum!"
  (Note the URL is pasted exactly as given, on its own line — never reworded or dropped.)

[Tanglish] FAQ query — COD:
  Customer: "COD available ah bro?"
  → Reply directly (NO tool call needed): "Aama bro, COD available! 🚚 Courier flat ₹50 COD fee iruku. UPI illa card la online pay panna extra charge illa."

[Tanglish] Quick FAQ — crisp, 2-3 sentences, straight to the answer (do NOT repeat the question back):
  Customer: "how many days for delivery to chennai?"
  → Reply: "Chennai-ku 2-3 days la delivery aagidum bro. Express shipping dhaan! 🚚"
  Customer: "price evlo bro?"
  → Reply: "Player version jersey ₹799 bro. Quality and fit semma irukum!"

[Tanglish] Stock/size check — offer to add to cart:
  Customer: "XL size stock iruka?"
  → [If unsure of the exact product/stock, use search_products first; if the product is already known, answer directly.]
  → Reply: "Iruku bro! XL size available. Cart la add pannatuma?"`
      : `WORKED EXAMPLES — Follow these exactly:

[English] Product search:
  Customer: "Do you have Chelsea jersey?"
  → [Use the search_products tool with query "Chelsea jersey"]  [ONLY use the tool, no text]
  Tool returns products.
  → Reply: "Yes! We have the *Chelsea Home 25/26 Jersey* at ₹849 🔵 Available in S/M/L/XL. Tap the link to see it: [url]. Which size would you like?"

[English] Product search — multiple matches (pick top 2-3, ONE question at the end, not after each):
  Customer: "Do you have Messi jerseys?"
  → [Use the search_products tool with query "messi jersey"]
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
Open the link, choose UPI or COD, and your order is placed!"
  (Note the URL is pasted exactly as given, on its own line — never reworded or dropped.)

[English] FAQ query — COD:
  Customer: "Do you support cash on delivery?"
  → Reply directly (NO tool call needed): "Yes, we support Cash on Delivery (COD)! 🚚 There's a flat ₹50 COD fee from the courier. You can also pay online via UPI or cards at no extra charge."`;

    // PROMPT-CACHING NOTE: everything above the "Current Session Context" line below is a
    // stable prefix (identical byte-for-byte across every call within a language), so the
    // OpenAI-compatible providers (Groq, Fireworks, Sarvam) auto-cache it and bill it at a
    // discount. The ONLY per-call-varying content (cart, address) is deliberately placed
    // LAST — if it sat near the top (as it used to) it would break the cache prefix and
    // nothing after it could be cached. Keep dynamic session state at the very end.
    const sessionContext = `---
Current Session Context (this is the ONLY part that changes per turn):
Cart: ${JSON.stringify(session.cart || [])}
Address: ${session.address || 'Not provided'}`;

    return `You are an expert, highly persuasive, and friendly AI Sales Assistant for "Theaurax.in" (a premium football jerseys retailer in India).
Your goal is to build a friendly connection and aggressively but politely guide customers to a successful checkout.

---
COMMON FAQs — a code-level matcher already answers these instantly with zero LLM calls
whenever the customer is idle with an empty cart (shipping, COD/payment, sizing, returns,
customization, bulk orders). If one of these topics comes up mid-flow (cart non-empty or
collecting address) and you need to answer it yourself, keep it brief and accurate — don't
invent policy details you're not sure of.
---

Tone & Style:
- Never sound like a robot. Be local, friendly, and hype up the products.
- If a product search returns many items, ONLY show the top 2 or 3 most relevant jerseys.

Instructions:
1. ALWAYS use 'search_products' when asked about jerseys. Never guess prices or stock.
2. If products are found, provide exact name, price, sizes, and permalink. Hype it up! (e.g., "Bro, indha jersey vera level!" OR "This jersey is absolutely stunning!")
3. When a user wants to buy, ask for size and quantity. Once BOTH are provided, use 'update_cart'.
4. After updating the cart, ask for their full shipping address (Name, Pincode, Mobile).
5. Once the address is provided, use 'set_shipping_address'. The order summary and total are shown to the customer automatically right after — you do NOT need to (and must not try to) write your own summary or total for this step.
6. Once the tool result confirms the cart is valid, use 'confirm_order'. If the tool says it's a Bulk Order, follow the tool's instructions.
7. Use emojis naturally to make it engaging.
8. IMPORTANT: When calling a tool, do NOT output conversational text before or after the tool call in the same message. Just use the tool.
9. BE SMART: If they reply with "M 3", interpret it as Size M, Quantity 3 for the last discussed product. ALWAYS use the exact productId when updating the cart.
10. CHECKOUT LINK: When confirm_order succeeds, the tool result will contain a paymentUrl. Paste that EXACT URL string verbatim, character-for-character, on its own line in your reply — never paraphrase it, shorten it, describe it ("I've sent your link"), or omit it. If the URL is missing from your reply, the customer cannot pay.
11. FORMATTING: When listing 2+ products, put each product on its own line (use a line break or bullet), never run them together in one sentence. Ask the size/quantity follow-up question ONCE, at the very end, after all products are listed — never repeat "which size?" after every single product. Keep replies in short, grammatically complete sentences — no sentence fragments or unrelated asides tacked onto the end of a reply.
12. NEVER call 'confirm_order' unless the customer's last message is PURELY a plain confirmation (yes/ok/confirm/seri, nothing else added). If they mention any change, correction, different item, different quantity, or a negation ("illa", "no", "wait", "change it") — do NOT confirm. Instead use 'update_cart' to fix the item first, then show the corrected summary and ask them to confirm again.

---
LANGUAGE RULE (CRITICAL — ALREADY DECIDED, DO NOT RE-DETECT):
- This customer's language has been detected as: ${isTanglish ? 'TANGLISH' : 'ENGLISH'}.
${isTanglish
  ? '- Respond ONLY in natural Tanglish (Tamil-English code-mixed, Roman script) for this ENTIRE conversation — e.g. "Bro, indha jersey vera level!", "Kandippa iruku!", "Enna size venum?". Never switch to pure English.'
  : '- Respond in professional, friendly English for this ENTIRE conversation. No Tamil/Tanglish words.'}
- This was decided from the customer\'s own words, not your guess — never override it mid-conversation.
${isTanglish ? `
TANGLISH STYLE (chat like a real, friendly Chennai/Tamil Nadu store owner on WhatsApp):
- Warm, casual openers: "Bro", "Ji", "Sure bro", "Kandippa", "Solren ji". Get STRAIGHT to the answer.
- Crisp — 2-3 short sentences max per reply. No walls of text.
- Keep product names, sizes (S/M/L/XL), prices, and terms like "delivery", "payment link", "stock", "size chart" in plain English. Mix them in naturally.
- Use REAL spoken chat phrases — never word-for-word translate English idioms into Tamil.

TANGLISH — STRICTLY NEVER DO THIS (these make you sound like a robot, not a human seller):
- NEVER use pure Tamil script (e.g. வணக்கம் / நன்றி). ALWAYS Roman letters (Vanakkam, Nandri).
- NEVER sound like Google Translate. WRONG: "Ungalukku naan eppadi uthavuven?" → RIGHT: "Enna jersey venum bro? Solliyae!"
- NEVER repeat the customer's full question back to them. Answer directly.
- NEVER spam emojis — 1 or 2 relevant ones per message, maximum.` : ''}

TOOL FORMAT (CRITICAL — ZERO TOLERANCE):
- When calling a tool, that turn contains ONLY the tool call. No text before, no text after.
- NEVER output XML-style tags like <function=name>...</function>. That is a bug. Never do it.
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
      }
    ];
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
    const htmlAlertMsg = `🚨 <b>New Wholesale Lead Alert!</b><br><br><b>Customer Details:</b><br>👤 Name: ${name}<br>📱 Phone: ${phone}<br>📍 Address: ${address}<br><br><b>Reason:</b> ${reason}<br><b>Message:</b> "${userQuery}"`;

    const ownerNumber = config.owner?.whatsappNumber;
    if (ownerNumber && whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
      const cleanOwner = ownerNumber.replace(/[^0-9]/g, '') + '@c.us';
      whatsappWebBot.client.sendMessage(cleanOwner, mdAlertMsg).catch(err => {
        console.error('[AI Service] Failed to send WhatsApp owner escalation alert:', err.message);
      });
    }

    if (config.telegram?.botToken && config.telegram?.chatId) {
      telegramService.sendAlert(htmlAlertMsg).catch(err => {
        console.error('[AI Service] Failed to send Telegram owner escalation alert:', err.message);
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

  async callLLMWithRetry(messages, client, provider = 'groq', keyIndex = 0, language = 'english') {
    const MAX_ATTEMPTS = 4;

    const model = provider === 'openai'
      ? (config.openai?.model || 'gpt-4o-mini')
      : provider === 'openrouter'
      ? (config.openrouter?.model || 'meta-llama/llama-3.3-70b-instruct:free')
      : provider === 'fireworks'
      ? (config.fireworks?.model || 'accounts/fireworks/models/deepseek-v4-pro')
      : provider === 'sarvam'
      ? (config.sarvam?.model || 'sarvam-30b')
      : provider === 'groq' && language === 'tanglish' && config.groq?.tanglishModel
      ? config.groq.tanglishModel
      : (config.groq?.model || 'llama-3.3-70b-versatile');

    // Qwen3 is a reasoning model — without this it leaks its full <think>...</think>
    // chain-of-thought into the reply content instead of just the final answer.
    const isQwenReasoning = provider === 'groq' && model.includes('qwen');

    // Fireworks' deepseek-v4-pro is also a reasoning model: it needs enough max_tokens
    // to finish its internal reasoning AND still emit the visible answer, or content
    // comes back empty/truncated (returns the answer cleanly in `content` on Fireworks,
    // so no reasoning_format flag is needed — verified in test_fireworks.js). No 8000 TPM
    // ceiling here (paid tier), so give it comfortable headroom.
    const isFireworks = provider === 'fireworks';

    // sarvam-30b is ALSO a reasoning model (contrary to the vendor docs used when it was
    // first wired). By default it spends the ENTIRE max_tokens budget on an internal
    // chain-of-thought — returned in a separate `reasoning_content` field — and leaves the
    // visible `content` null/truncated. Verified live 2026-07-22: at max_tokens 800 AND 1500
    // `content` came back null (finish_reason 'length'); only ~2500 let it finish, at
    // ~1400 tokens/reply. The `/no_think` control tag disables that reasoning pass entirely:
    // same clean Tanglish answer AND full tool-calling, in ~100-180 tokens. So for Sarvam we
    // append `/no_think` to the system message (below) and keep the normal 800 budget.
    const isSarvam = provider === 'sarvam';

    // Qwen's free tier caps at 8000 TPM/key for prompt+max_tokens COMBINED — much
    // tighter than Llama's. A multi-turn conversation's accumulated history can alone
    // approach that ceiling, so give it a much smaller trim budget than other providers.
    let trimmed = this.trimMessagesToTokenBudget(messages, isQwenReasoning ? 9000 : 20000);

    // For Sarvam only, append the `/no_think` control tag to the system prompt so the model
    // returns its answer directly instead of exhausting max_tokens on reasoning (see note
    // above). Other providers' messages are left byte-identical so their cacheable prefix
    // is unaffected.
    if (isSarvam) {
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
          tools: this.getTools(),
          tool_choice: 'auto',
          // Qwen's hidden <think> reasoning draws from the same max_tokens budget as the
          // visible answer — 800 was tuned for non-reasoning Llama and left zero room for
          // an actual reply once reasoning ran long, silently truncating to empty content.
          // qwenMaxTokens is sized dynamically against the actual prompt for this call
          // (see above) so it can't itself tip the request over the 8000 TPM ceiling.
          max_tokens: isQwenReasoning ? qwenMaxTokens : isFireworks ? 1500 : 800,
          temperature: attempt <= 2 ? 0.7 : 0.2,
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
   * Build the ordered key list for one provider, rotated by a round-robin cursor.
   * Without this, every request tries keyIndex 0 first and only reaches the other
   * keys on an actual error — under concurrent load that means all traffic piles
   * onto key 0 (starving it fast) instead of spreading across the available keys.
   */
  rotateEntries(name, clients, type) {
    const entries = clients.map((client, i) => ({ name, client, type, keyIndex: i }));
    if (entries.length <= 1) return entries;
    const cursor = AIService.roundRobinIndex[name] || 0;
    AIService.roundRobinIndex[name] = (cursor + 1) % entries.length;
    return [...entries.slice(cursor), ...entries.slice(0, cursor)];
  }

  async callLLMWithFallback(messages, language = 'english') {
    // Build a flat list of all API clients across all providers for key rotation.
    const entries = [];
    const groqEntries = this.rotateEntries('groq', this.groqClients, 'openai');
    const geminiEntries = this.rotateEntries('gemini', this.geminiClients, 'gemini');
    const openrouterEntries = this.rotateEntries('openrouter', this.openrouterClients, 'openai');
    const fireworksEntries = this.rotateEntries('fireworks', this.fireworksClients, 'openai');
    const sarvamEntries = this.rotateEntries('sarvam', this.sarvamClients, 'openai');

    if (language === 'tanglish') {
      // Sarvam (sarvam-30b) is purpose-trained on romanized/code-mixed Tamil — best
      // Tanglish quality and cheapest, so it's tried FIRST. Fireworks (deepseek-v4-pro)
      // is the paid backup below it (also strong at code-mixing), then Groq/Llama-3.3 as
      // the fast free backstop. Gemini's old Tanglish-first slot is dead (free tier
      // returns limit:0). If neither Sarvam nor Fireworks keys are set, this degrades
      // cleanly to Groq-first.
      entries.push(...sarvamEntries, ...fireworksEntries, ...groqEntries);
    } else {
      // English: Groq stays primary (fast, free); Fireworks then Sarvam as paid fallbacks.
      entries.push(...groqEntries, ...fireworksEntries, ...sarvamEntries);
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
          result = await this.callLLMWithRetry(messages, entry.client, entry.name, entry.keyIndex, language);
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
          ? (config.fireworks?.model || 'accounts/fireworks/models/deepseek-v4-pro')
          : entry.name === 'sarvam'
          ? (config.sarvam?.model || 'sarvam-30b')
          : entry.name === 'gemini'
          ? (config.gemini?.model || 'gemini-2.0-flash')
          : entry.name === 'groq' && language === 'tanglish' && config.groq?.tanglishModel
          ? config.groq.tanglishModel
          : (config.groq?.model || 'llama-3.3-70b-versatile');

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
          ? (config.fireworks?.model || 'accounts/fireworks/models/deepseek-v4-pro')
          : entry.name === 'sarvam'
          ? (config.sarvam?.model || 'sarvam-30b')
          : entry.name === 'gemini'
          ? (config.gemini?.model || 'gemini-2.0-flash')
          : entry.name === 'groq' && language === 'tanglish' && config.groq?.tanglishModel
          ? config.groq.tanglishModel
          : (config.groq?.model || 'llama-3.3-70b-versatile');

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
        const retryResponse = await this.answerQuery(senderId, userQuery, customerName, customerPhone);

        if (retryResponse.intent === 'quota_exhausted') {
          shouldDelete = false;
        } else if (whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
          try {
            await whatsappWebBot.client.sendMessage(senderId, retryResponse.replyText);
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
            entry.customerPhone
          );

          if (retryResponse.intent === 'quota_exhausted') {
            shouldDelete = false;
          } else if (whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
            try {
              await whatsappWebBot.client.sendMessage(entry.senderId, retryResponse.replyText);
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

  /**
   * Deterministically parse a "pick size + quantity" reply (e.g. "M size 2",
   * "1st one, L 3", "XL") against the products shown in the last search, with zero
   * LLM call. Returns null on anything not confidently parseable — callers must fall
   * through to the LLM in that case. Never guesses a size the product doesn't actually
   * sell, and bails on long/sentence-like input to avoid misfiring on an unrelated
   * message that happens to contain a size letter.
   */
  parseSizeQtyReply(userQuery, lastShownProducts, pendingProductIndex = null) {
    const q = (userQuery || '').toLowerCase().trim();
    if (!q || q.length > 60) return null;

    const sizeMatch = q.match(/\b(xxxl|xxl|xl|s|m|l)\b/i);
    if (!sizeMatch) return null;
    const size = sizeMatch[1].toUpperCase();

    // Word-form ordinals ("1st", "first"...) always mean product selection.
    // A bare digit ("3", "2") only counts as a selector when paired with an explicit
    // selection word right next to it ("3 okey", "2 option") — a bare number on its own
    // is ambiguous with the documented qty-only shorthand ("M size 2" = qty 2 for the
    // default/pending product), so treating every bare digit as an ordinal would break
    // that shorthand whenever 2+ products were shown. This distinction is what was
    // silently corrupting both the product AND the quantity in "3 okey bro S size 4
    // quantities" — the leading "3" (meant to pick product #3) was never recognized as
    // an ordinal, so it defaulted to product #1 AND got eaten by the quantity regex
    // instead of the real "4".
    const wordOrdinals = [
      ['1st', 0], ['first', 0], ['2nd', 1], ['second', 1],
      ['3rd', 2], ['third', 2], ['4th', 3], ['fourth', 3]
    ];
    let productIndex = pendingProductIndex !== null ? pendingProductIndex : 0;
    let consumedToken = null;
    for (const [word, idx] of wordOrdinals) {
      const m = q.match(new RegExp(`\\b${word}\\b`));
      if (m) { productIndex = idx; consumedToken = m[0]; break; }
    }
    if (!consumedToken) {
      const bareDigitMatch = q.match(/\b([1-4])\b\s*(?:st|nd|rd|th)?\s*(?:okey|okay|ok|option|opt|venum|vendum|select|number|no\.?)\b/i);
      if (bareDigitMatch) {
        productIndex = parseInt(bareDigitMatch[1], 10) - 1;
        consumedToken = bareDigitMatch[1];
      }
    }
    const product = lastShownProducts[productIndex];
    if (!product) return null;

    // Only trust a size the product actually lists — guards against a coincidental
    // letter match landing on a size that isn't even sold for this item.
    if (product.sizes && product.sizes.length > 0) {
      const sizeAvailable = product.sizes.some(s => s.toUpperCase().startsWith(size));
      if (!sizeAvailable) return null;
    }

    // Strip the consumed ordinal token and the size token, then take the first
    // remaining standalone number as quantity. The trailing boundary is intentionally
    // NOT required, so a qty glued to its unit word with no space (e.g. "2quantites",
    // a real typo seen in production) still parses instead of silently defaulting to 1.
    let stripped = q;
    if (consumedToken) stripped = stripped.replace(consumedToken, '');
    stripped = stripped.replace(new RegExp(`\\b${size.toLowerCase()}\\b`, 'i'), '');
    const qtyMatch = stripped.match(/(?<!\d)(\d{1,2})(?!\d)/);
    const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
    if (qty < 1 || qty > 50) return null;

    return { productId: product.productId, name: product.name, price: product.price, size, qty };
  }

  /**
   * Handles a bare product-selection reply with no size/qty yet (e.g. "2", "1st",
   * "3rd one") — the exact reply the numbered search-result template invites
   * ("Ethu venum bro — 1, 2 illa 3?"). Without this, a bare number falls through to the
   * LLM, which has no tool for "remember this selection" and was observed re-running
   * search_products instead, returning a different unrelated list each time.
   */
  parseProductSelectionOnly(userQuery, lastShownProducts) {
    const q = (userQuery || '').toLowerCase().trim();
    if (!q || q.length > 25) return null;
    if (/\b(xxxl|xxl|xl|s|m|l)\b/i.test(q)) return null; // has a size — let parseSizeQtyReply handle it

    const wordOrdinals = [
      ['1st', 0], ['first', 0], ['2nd', 1], ['second', 1],
      ['3rd', 2], ['third', 2], ['4th', 3], ['fourth', 3]
    ];
    for (const [word, idx] of wordOrdinals) {
      if (new RegExp(`\\b${word}\\b`).test(q)) return lastShownProducts[idx] ? idx : null;
    }
    const bareMatch = q.match(/^([1-4])\s*(?:st|nd|rd|th)?\s*(?:okey|okay|ok|option|opt|venum|vendum|select|number|no\.?)?$/i);
    if (bareMatch) {
      const idx = parseInt(bareMatch[1], 10) - 1;
      return lastShownProducts[idx] ? idx : null;
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
    const orderResult = await woocommerceService.createOrder(session.cart, addrDetails, session.customerName);
    return {
      ok: true,
      orderId: orderResult.success ? orderResult.orderId : null,
      checkoutUrl: orderResult.success ? orderResult.paymentUrl : null
    };
  }

  async answerQuery(senderId, userQuery, customerName = null, customerPhone = null) {
    const session = await dbService.getSession(senderId);
    if (customerName && customerName !== 'Customer') session.customerName = customerName;
    if (customerPhone) session.customerPhone = customerPhone;

    // Detect language every turn, but only ever move TOWARD Tanglish, never away from
    // it. A neutral opener like "hi" carries no signal and used to lock the whole
    // conversation into English permanently before a real Tanglish word ever showed up
    // (e.g. "iruka bro" on message 2) — now a Tanglish word on ANY turn switches the
    // session over and stays there; plain-English replies afterward (numbers, product
    // names) no longer flip it back.
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
    session.history = validHistory.slice(-4);

    let resultText = "";
    let isConfirmed = false;
    let requiresEscalation = false;
    let checkoutUrl = null;
    let quotaExhaustedWaitMs = null;
    let matchedProductIds = [];

    if (this.groqClients.length === 0 && this.openaiClients.length === 0 && this.openrouterClients.length === 0 && this.fireworksClients.length === 0 && this.sarvamClients.length === 0 && this.geminiClients.length === 0) {
      resultText = "I'm currently undergoing maintenance. Please reach out to our support number directly on WhatsApp.";
      return { replyText: resultText, intent: 'error', requiresEscalation: false, suggestedProductIds: [] };
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
        await dbService.saveSession(senderId, session);
        return { replyText: answer, intent: 'knowledge', requiresEscalation: false, suggestedProductIds: [] };
      }

      const faqMatches = faqService.searchFAQs(userQuery);
      if (faqMatches.length > 0) {
        const answer = faqMatches[0].answer;
        session.history.push({ role: 'user', content: userQuery });
        session.history.push({ role: 'assistant', content: answer });
        await dbService.saveSession(senderId, session);
        return { replyText: answer, intent: 'faq', requiresEscalation: false, suggestedProductIds: [] };
      }
    }

    // --- Deterministic size+quantity parser ---
    // The highest-frequency turn after a product search: customer just needs to pick
    // size+qty. Parsing it in code is instant, free, and can't hallucinate a wrong
    // product/size — parseSizeQtyReply returns null on anything not confidently
    // parseable, which falls straight through to the LLM below as before.
    if (isIdle && session.cart.length === 0 && session.lastShownProducts?.length > 0 && userQuery) {
      const parsed = this.parseSizeQtyReply(userQuery, session.lastShownProducts, session.pendingProductIndex ?? null);
      if (parsed) {
        session.cart = [{ productId: parsed.productId, name: parsed.name, price: parsed.price, size: parsed.size, qty: parsed.qty }];
        session.state = 'COLLECTING_ADDRESS';
        session.pendingProductIndex = null;
        const isTanglish = session.language === 'tanglish';
        const reply = isTanglish
          ? `Done bro! 🛒 *${parsed.name}* — ${parsed.size} size, ${parsed.qty} qty cart la potten! Ippo shipping details sollunga — Name, Address, Pincode, Mobile number.`
          : `Done! 🛒 Added *${parsed.name}* — Size ${parsed.size}, Qty ${parsed.qty} to your cart! Now share your shipping details — Name, Address, Pincode, Mobile number.`;
        session.history.push({ role: 'user', content: userQuery });
        session.history.push({ role: 'assistant', content: reply });
        await dbService.saveSession(senderId, session);
        return { replyText: reply, intent: 'deterministic_cart', requiresEscalation: false, suggestedProductIds: [parsed.productId] };
      }

      // --- Bare product-selection reply (no size/qty yet) ---
      // e.g. "2", "1st" — exactly what the numbered search-result template invites
      // ("Ethu venum bro — 1, 2 illa 3?"). Remember the pick and ask for size/qty
      // specifically for that product, instead of falling to the LLM (which has no tool
      // for "remember this selection" and was observed re-running search_products,
      // returning a different unrelated list each time the customer just replied "2").
      const selectedIdx = this.parseProductSelectionOnly(userQuery, session.lastShownProducts);
      if (selectedIdx !== null) {
        session.pendingProductIndex = selectedIdx;
        const p = session.lastShownProducts[selectedIdx];
        const isTanglish = session.language === 'tanglish';
        const sizeText = p.sizes && p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : '';
        const reply = isTanglish
          ? `Semma bro! 🔥 *${p.name}*${sizeText} — enna size, evlo quantity venum? 🛍️`
          : `Great pick! 🔥 *${p.name}*${sizeText} — what size, and how many would you like? 🛍️`;
        session.history.push({ role: 'user', content: userQuery });
        session.history.push({ role: 'assistant', content: reply });
        await dbService.saveSession(senderId, session);
        return { replyText: reply, intent: 'deterministic_selection', requiresEscalation: false, suggestedProductIds: [p.productId] };
      }
    }

    // --- Deterministic order-confirmation bypass ---
    // Only short-circuits on a message that IS ENTIRELY a confirmation word/phrase —
    // anchored full-string match, not substring — so "yes but change the address"
    // still goes to the LLM instead of confirming blindly.
    if (session.state === 'CONFIRMING_ORDER' && userQuery) {
      const isConfirmReply = /^\s*(yes+|yeah|yep|ye+p|confirm(ed)?|ok(ay)?|okey|sure|correct|right|seri|sari|proceed|go ahead|order pannunga|book pannunga|place (the )?order)\s*[!.]*\s*$/i.test(userQuery.trim());
      if (isConfirmReply) {
        const result = await this._confirmOrderNow(session, senderId);
        if (result.ok) {
          const isTanglish = session.language === 'tanglish';
          let reply = result.checkoutUrl
            ? (isTanglish
                ? `Semma bro! 🎉 Order #${result.orderId} confirm aayiduchi! Idha click pannunga pay pannurathukku: ${result.checkoutUrl}\nUPI or COD select pannunga. Thanks for shopping with Theaurax! ⚽🔥`
                : `Awesome! 🎉 Your order #${result.orderId} is confirmed! Tap here to complete payment: ${result.checkoutUrl}\nChoose UPI or COD. Thanks for shopping with Theaurax! ⚽🔥`)
            : (isTanglish
                ? `Semma bro! 🎉 Order confirm aayiduchi! Naanga team soon contact pannuvom payment confirm pannurathukku. Thanks! ⚽🔥`
                : `Awesome! 🎉 Your order is confirmed! Our team will reach out shortly to confirm payment. Thanks for shopping with Theaurax! ⚽🔥`);

          const cartSnapshot = session.cart;
          if (!result.checkoutUrl && cartSnapshot.length > 0) {
            try {
              const fallbackOrderId = `order_${Date.now()}_${senderId.toString().substring(0, 4)}`;
              await generateInvoicePDF(fallbackOrderId, {
                userId: senderId,
                customerName: session.customerName || `Customer (${senderId})`,
                cart: cartSnapshot,
                address: session.address
              });
              const baseUrl = config.baseUrl || 'http://localhost:3000';
              reply += `\n\n📄 *Proforma Invoice*: ${baseUrl}/invoices/invoice_${fallbackOrderId}.pdf`;
            } catch (invoiceErr) {
              console.error('[AI Service] Fallback PDF invoice failed (deterministic confirm):', invoiceErr.message);
            }
          }

          session.history.push({ role: 'user', content: userQuery });
          session.history.push({ role: 'assistant', content: reply });
          session.state = 'IDLE';
          session.cart = [];
          session.address = null;
          session.addressDetails = null;
          session.history = [];

          await dbService.saveSession(senderId, session);
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

    messages.push({ role: "user", content: userQuery });

    let keepLooping = true;
    let loops = 0;
    let forcedSearchRetryDone = false;
    let lastSearchResults = null;

    while (keepLooping && loops < 5) {
      loops++;
      try {
        const completion = await this.callLLMWithFallback(messages, session.language);

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
              const products = woocommerceService.searchProducts(args.query || "");
              matchedProductIds = products.map(p => p.id);
              lastSearchResults = products;
              // Persisted so a later turn (e.g. "1st one, M size 2") can resolve which
              // product the customer means without an LLM call — see parseSizeQtyReply.
              session.lastShownProducts = products.slice(0, 10).map(p => ({
                productId: p.id, name: p.name, price: p.price, sizes: p.sizes || []
              }));
              // A fresh search invalidates any earlier "customer picked #2" memory —
              // that index referred to the OLD list.
              session.pendingProductIndex = null;

              // Skip the second "narration" LLM call entirely — template it directly.
              // Originally only did this for a single confident match; multi-match search
              // results were left to the LLM to narrate, which proved unreliable (Llama-3.3
              // on Groq would repeat the "which size?" question after every single product
              // instead of asking once at the end, and vary the list format turn to turn).
              // Templating deterministically for 1-3 matches guarantees correct formatting,
              // a numbered list customers can reply to ("1st one"), and saves an LLM turn.
              if (products.length >= 1 && responseMessage.tool_calls.length === 1) {
                const top = products.slice(0, 3);
                const isTanglish = session.language === 'tanglish';
                const hypeOpeners = isTanglish
                  ? ['Bro kandippa iruku! 🔥', 'Semma choice bro! 😍', 'Idhu vera level bro! 🏆']
                  : ['Yes, we have it! 🔥', 'Great pick! 😍', 'This one\'s a favorite! 🏆'];
                const opener = hypeOpeners[Math.floor(Math.random() * hypeOpeners.length)];

                if (top.length === 1) {
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
                    ? `${opener}\n${lines}\n\nEthu venum bro — 1, 2 illa 3? Enna size, evlo quantity venum? 🛍️`
                    : `${opener}\n${lines}\n\nWhich one would you like — 1, 2, or 3? What size and how many? 🛍️`;
                }

                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: fnName,
                  content: JSON.stringify({ products, message: "Found products" })
                });
                keepLooping = false;
                break;
              }

              toolResultObj = { products: products.length > 0 ? products : null, message: products.length > 0 ? "Found products" : "No matching products found. Advise user to search website: https://theaurax.in/?s=" + encodeURIComponent(args.query || "") };
            } else if (fnName === "update_cart") {
              session.cart = [{
                productId: args.productId,
                name: args.name,
                price: args.price,
                size: args.size,
                qty: args.qty
              }];
              session.state = 'COLLECTING_ADDRESS';
              toolResultObj = { status: "success", message: "Cart updated successfully. Ask user for their shipping address next." };
            } else if (fnName === "set_shipping_address") {
              // Some models emit phone/pincode as bare JSON numbers — normalize to
              // strings here since downstream code (parseAddressDetails) calls .replace()
              // on these and would throw on a raw number.
              const phone = String(args.phone ?? '');
              const pincode = String(args.pincode ?? '');
              session.addressDetails = { name: args.name, phone, address: args.address, pincode };
              session.address = `${args.name}, ${args.address}, ${pincode} | Ph: ${phone}`;
              session.customerPhone = phone;
              if (args.name && args.name !== 'Customer') session.customerName = args.name;
              // Update customer registry with confirmed phone number
              dbService.saveCustomer(senderId, args.name, phone).catch(() => {});

              const totalQty = session.cart.reduce((sum, item) => sum + parseInt(item.qty || 0), 0);
              const bulkThreshold = config.owner?.bulkThreshold || 10;

              if (totalQty >= bulkThreshold) {
                requiresEscalation = true;
                session.requiresEscalation = true;
                session.state = 'IDLE';
                session.escalationDetails = {
                  reason: `Bulk Order (${totalQty} items)`,
                  name: args.name || session.customerName,
                  phone: args.phone || senderId.replace(/[^0-9]/g, ''),
                  address: session.address
                };
                toolResultObj = { status: "success", message: `CRITICAL: Cart quantity is ${totalQty}, which is a bulk order. DO NOT ask to confirm order. Tell the user our wholesale team will reach out to them shortly.` };
              } else {
                session.state = 'CONFIRMING_ORDER';
                // Template the order summary deterministically from session.cart instead
                // of letting the LLM narrate it freely — narration was observed fabricating
                // a second line item pulled from earlier conversation history that was
                // never actually added to the cart (the cart is guaranteed single-item by
                // design, replaced on each update_cart call). Money-facing totals shouldn't
                // depend on the model reading its own context correctly.
                const isTanglish = session.language === 'tanglish';
                const total = session.cart.reduce((sum, item) => sum + (parseFloat(item.price) || 0) * (parseInt(item.qty, 10) || 0), 0);
                const itemLines = session.cart.map(item =>
                  `• *${item.name}* — ${item.size} size, ${item.qty} qty — ₹${(parseFloat(item.price) || 0) * (parseInt(item.qty, 10) || 0)}`
                ).join('\n');
                resultText = isTanglish
                  ? `Bro, unga order summary:\n${itemLines}\nTotal: ₹${total}\n\nConfirm pannunga bro, reply "YES" 🎉`
                  : `Here's your order summary:\n${itemLines}\nTotal: ₹${total}\n\nReply "YES" to confirm! 🎉`;
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: fnName,
                  content: JSON.stringify({ status: "success", message: "Address saved." })
                });
                keepLooping = false;
                break;
              }
            } else if (fnName === "escalate_to_human") {
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

              isConfirmed = true;
              session.state = 'IDLE';

              const addrDetails = session.addressDetails || {
                name: session.customerName || 'Customer',
                phone: session.customerPhone || senderId.replace(/\D/g, ''),
                address: session.address || '',
                pincode: ''
              };
              const orderResult = await woocommerceService.createOrder(session.cart, addrDetails, session.customerName);

              if (orderResult.success) {
                checkoutUrl = orderResult.paymentUrl;
                toolResultObj = {
                  status: "success",
                  orderId: orderResult.orderId,
                  paymentUrl: checkoutUrl,
                  message: `Order #${orderResult.orderId} created! Share this payment link with the customer so they can complete checkout: ${checkoutUrl}. Tell them to tap the link, choose UPI or COD, and confirm. Be warm and enthusiastic!`
                };
              } else {
                toolResultObj = { status: "success", message: "Order noted manually. Tell the customer our team will reach out shortly to confirm payment. Be warm and end on a positive note." };
              }
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify(toolResultObj)
            });
          }
        } else {
          resultText = responseMessage.content || "Sorry, I couldn't process that.";
          // Capture BEFORE stripping — a JSON-shaped tool-call leak is a sign of failure
          // regardless of whether the regexes below manage to fully clean it out.
          const rawContentLookedLikeJson = /^\s*\{[\s\S]*\}\s*$/.test(resultText)
            && /"(function|name|type|parameters|query)"\s*:/i.test(resultText);

          // Groq Bug Fix: strip all known leaked tool-call formats
          resultText = resultText.replace(/<?\/?function=.*?>.*?<\/function>/gs, '').trim();
          resultText = resultText.replace(/[a-zA-Z_]+>\s*\{.*?\}/gs, '').trim();
          // JSON-style leak — handles one level of nested braces e.g. {"type":"function","parameters":{"topic":"..."}}
          resultText = resultText.replace(/\{"type"\s*:\s*"function"(?:[^{}]|\{[^{}]*\})*\}/g, '').trim();
          // Bare "toolName{...}" or "toolName(...)" leak — no wrapper tags at all, just the raw call
          resultText = resultText.replace(/\b(?:search_products|update_cart|set_shipping_address|escalate_to_human|confirm_order)\s*\(?\s*\{[\s\S]*?\}\)?/g, '').trim();
          // Malformed/incomplete function-tag leak with no "=" or JSON body at all,
          // e.g. a bare "<function(</function>" — seen in production when generation
          // got cut off mid tool-call. Strip any stray <function...> / </function> fragment.
          resultText = resultText.replace(/<\/?function\b[^>]*>?/gi, '').trim();
          // Catch any remaining garbage (orphaned braces/punctuation/tag fragments from partial strip)
          const wasStrippedToGarbage = !resultText || /^[\s{}\[\],"':<>\/()]+$/.test(resultText);
          if (wasStrippedToGarbage) {
            resultText = "Sorry about that! 🙏 Could you tell me again what you're looking for? I'll sort you out right away.";
          }

          // Guardrail: the model sometimes gives up on tool-calling (esp. after a Groq
          // tool_use_failed glitch) and sends a non-answer instead of a real reply. Known
          // shapes: (a) it recites the FAQ greeting boilerplate from the system prompt
          // verbatim, ignoring the actual question; (b) it leaks a raw/malformed tool-call
          // JSON as plain text (e.g. {"function":"search_products","query":"..."}), whether
          // or not the stripping regexes above fully cleaned it; (c) stripping left nothing
          // but the generic "could you repeat that" placeholder. By this point the pre-AI
          // FAQ matcher has already ruled out a genuine greeting, so any of these is a leak —
          // force one retry with search_products required before sending a non-answer.
          const greetingFaq = faqService.getFAQs().find(f => f.category === 'Greetings');
          const looksLikeGreetingLeak = /welcome to theaurax\.in/i.test(resultText)
            || (greetingFaq && resultText.toLowerCase().includes(greetingFaq.question.toLowerCase()));
          const looksLikeRawJsonLeak = rawContentLookedLikeJson || wasStrippedToGarbage;
          if (looksLikeGreetingLeak || looksLikeRawJsonLeak) {
            if (!forcedSearchRetryDone && loops < 5) {
              forcedSearchRetryDone = true;
              messages.push({
                role: "system",
                content: looksLikeRawJsonLeak
                  ? `Your last reply was broken raw JSON, not a real answer or a proper tool call. The customer's last message was: "${userQuery}". Call the search_products tool NOW (as an actual tool call, not text) with that exact query to answer it.`
                  : `You just replied with the generic welcome greeting instead of answering. The customer's last message was: "${userQuery}". Call the search_products tool now with that exact query to answer it. Do not greet again.`
              });
              continue;
            }
            // The model repeated the leak even after the nudge — stop trusting its free-text
            // narration and build a deterministic reply directly from real search results
            // instead of sending a non-answer to the customer.
            const isTanglish = session.language === 'tanglish';
            if (lastSearchResults && lastSearchResults.length > 0) {
              const top = lastSearchResults.slice(0, 3);
              const intro = isTanglish ? "Idhu iruku bro! 🔥" : "Here's what we have for you! 🔥";
              const outro = isTanglish ? "Enna size venum, sollunga!" : "Which one would you like, and what size?";
              resultText = intro + "\n\n" + top.map(p =>
                `• *${p.name}* — ₹${p.price}${p.sizes && p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : ''}${p.permalink ? `\n  ${p.permalink}` : ''}`
              ).join('\n') + "\n\n" + outro;
            } else {
              resultText = isTanglish
                ? "Andha exact jersey kidaikala bro — team illa player name sollunga innoru thadava? Illa website la paarunga: https://theaurax.in"
                : "Hmm, I couldn't find that exact jersey — could you tell me the team or player name again? Or browse the full range here: https://theaurax.in";
            }
          }

          keepLooping = false;
        }
      } catch (err) {
        if (err.isQuotaExhausted) {
          console.warn(`[AI Service] Groq daily token quota exhausted. Will retry this message in ${Math.round(err.waitMs / 1000)}s.`);
          quotaExhaustedWaitMs = err.waitMs;
          // --- No-LLM Fallback: when all providers are exhausted, try local product cache ---
          resultText = this._buildNoLLMFallback(userQuery, session.language);
        } else {
          console.error('[AI Service] Groq API error:', err.error ? JSON.stringify(err.error) : err.message || err);
          // No-LLM fallback for non-quota errors too — show products from local cache
          resultText = this._buildNoLLMFallback(userQuery, session.language);
        }
        keepLooping = false;
      }
    }

    if (quotaExhaustedWaitMs !== null) {
      // Don't persist this placeholder into conversation history - schedule a real
      // re-run of the original query once the daily quota window resets instead.
      await dbService.saveSession(senderId, session);
      this.scheduleQuotaRetry(senderId, userQuery, customerName, customerPhone, quotaExhaustedWaitMs);
      return { replyText: resultText, intent: 'quota_exhausted', requiresEscalation: false, suggestedProductIds: [] };
    }

    session.history.push({ role: 'user', content: userQuery });
    session.history.push({ role: 'assistant', content: resultText });

    if (isConfirmed) {
      if (!checkoutUrl && session.cart && session.cart.length > 0) {
        // Fallback: WooCommerce order creation failed — generate PDF invoice instead
        try {
          const fallbackOrderId = `order_${Date.now()}_${senderId.toString().substring(0, 4)}`;
          await generateInvoicePDF(fallbackOrderId, {
            userId: senderId,
            customerName: session.customerName || `Customer (${senderId})`,
            cart: session.cart,
            address: session.address
          });
          const baseUrl = config.baseUrl || 'http://localhost:3000';
          resultText += `\n\n📄 *Proforma Invoice*: ${baseUrl}/invoices/invoice_${fallbackOrderId}.pdf`;
          console.log(`[AI Service] Fallback PDF invoice created for ${fallbackOrderId}`);
        } catch (invoiceErr) {
          console.error('[AI Service] Fallback PDF invoice failed:', invoiceErr.message);
        }
      }
      session.cart = [];
      session.address = null;
      session.addressDetails = null;
      session.history = [];
    }

    if (requiresEscalation) {
      this.sendEscalationAlert(senderId, userQuery, session);
      // Reset the session so future bulk orders also trigger alerts
      session.cart = [];
      session.address = null;
      session.history = [];
      session.hasEscalated = false;
      session.requiresEscalation = false;
    }

    await dbService.saveSession(senderId, session);
    
    await dbService.saveLead({
      userId: senderId,
      name: session.customerName || customerName || 'Customer',
      phone: senderId.replace(/[^0-9]/g, ''),
      channel: 'whatsapp',
      cart: session.cart || [],
      address: session.address || null,
      requiresEscalation: session.requiresEscalation || false,
      status: session.state === 'IDLE' && session.cart.length === 0 ? 'completed' : 'active',
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

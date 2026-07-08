import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config/config.js';
import faqService from './faq.js';
import woocommerceService from './woocommerce.js';
import dbService from './db.js';
import { generateInvoicePDF } from './invoice.js';
import whatsappWebBot from './whatsapp-web-bot.js';
import telegramService from './telegram.js';
import sheetsService from './sheets.js';

class AIService {
  // --- Rate-limit throttling ---
  // Global minimum gap between LLM API calls to reduce 429 errors.
  static lastApiCallTime = 0;
  static minApiGapMs = 600; // ~100 RPM max (Groq free tier allows 30 RPM, this is conservative)

  async callWithThrottle(fn) {
    const now = Date.now();
    const elapsed = now - AIService.lastApiCallTime;
    if (elapsed < AIService.minApiGapMs) {
      await new Promise(r => setTimeout(r, AIService.minApiGapMs - elapsed));
    }
    AIService.lastApiCallTime = Date.now();
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
  }

  generateSystemPrompt(session) {
    const faqs = faqService.getFAQs();
    const faqSection = faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');

    return `You are an expert, highly persuasive, and friendly AI Sales Assistant for "Theaurax.in" (a premium football jerseys retailer in India).
Your goal is to build a friendly connection and aggressively but politely guide customers to a successful checkout.

---
COMMON FAQs — Answer these DIRECTLY from this section. Do NOT call any tool for these topics:
${faqSection}
---

Tone & Style:
- MIRROR THE CUSTOMER'S LANGUAGE. 
- If the customer speaks English, reply in English.
- If the customer uses Tanglish or Tamil, switch to natural Tanglish (e.g., "Bro", "Machan", "Kandippa").
- Never sound like a robot. Be local, friendly, and hype up the products.
- If a product search returns many items, ONLY show the top 2 or 3 most relevant jerseys.

Current Session Context:
Cart: ${JSON.stringify(session.cart || [])}
Address: ${session.address || 'Not provided'}

Instructions:
1. ALWAYS use 'search_products' when asked about jerseys. Never guess prices or stock.
2. If products are found, provide exact name, price, sizes, and permalink. Hype it up! (e.g., "Bro, indha jersey vera level!" OR "This jersey is absolutely stunning!")
3. When a user wants to buy, ask for size and quantity. Once BOTH are provided, use 'update_cart'.
4. After updating the cart, ask for their full shipping address (Name, Pincode, Mobile).
5. Once the address is provided, use 'set_shipping_address'.
6. If the tool says "Address saved", display an order summary and ask them to reply YES to confirm. Once confirmed, use 'confirm_order'. If the tool says it's a Bulk Order, follow the tool's instructions.
7. Use emojis naturally to make it engaging.
8. IMPORTANT: When calling a tool, do NOT output conversational text before or after the tool call in the same message. Just use the tool.
9. BE SMART: If they reply with "M 3", interpret it as Size M, Quantity 3 for the last discussed product. ALWAYS use the exact productId when updating the cart.
10. CHECKOUT LINK: When confirm_order succeeds, the tool result will contain a paymentUrl. Share it clearly with the customer as their checkout link.

---
LANGUAGE RULE (CRITICAL):
- Detect language from the VERY FIRST message. If ANY Tamil or Tanglish words appear (e.g. "bro", "machan", "iruka", "vennum", "poda", "illa", "enna", "soldra"), switch to FULL Tanglish mode and STAY in it.
- English customers get professional, friendly English. No mixing.
- Never revert language mid-conversation.

TOOL FORMAT (CRITICAL — ZERO TOLERANCE):
- When calling a tool, that turn contains ONLY the tool call. No text before, no text after.
- NEVER output XML-style tags like <function=name>...</function>. That is a bug. Never do it.
- After the tool returns a result, write your reply naturally based on the result.

WORKED EXAMPLES — Follow these exactly:

[English] Product search:
  Customer: "Do you have Chelsea jersey?"
  → [Use the search_products tool with query "Chelsea jersey"]  [ONLY use the tool, no text]
  Tool returns products.
  → Reply: "Yes! We have the *Chelsea Home 25/26 Jersey* at ₹849 🔵 Available in S/M/L/XL. Tap the link to see it: [url]. Which size would you like?"

[Tanglish] Product search + order:
  Customer: "bro chelsea jersey iruka?"
  → [Use the search_products tool with query "chelsea jersey"]
  Tool returns products.
  → Reply: "Bro kandippa iruku! 🔥 *Chelsea Home 25/26 Jersey* — ₹849 la kedaikuthu! S, M, L, XL size la iruku. Enna size venum?"
  Customer: "L bro 1 venum"
  → [Use the update_cart tool with productId:45, name:"Chelsea Home 25/26 Jersey", price:849, size:"L", qty:1]
  Tool returns success.
  → Reply: "Done bro! 🛒 Cart la potten! Ippo shipping details sollu — Peyar, Address, Pincode, Mobile number."

[English] FAQ query — COD:
  Customer: "Do you support cash on delivery?"
  → Reply directly from COMMON FAQs section above (NO tool call needed): "Yes, we support Cash on Delivery (COD)! 🚚 There's a flat ₹50 COD fee from the courier. You can also pay online via UPI or cards at no extra charge."

[English] FAQ query — shipping:
  Customer: "How long does delivery take?"
  → Reply directly: "We ship all across India! 🚚 Metro cities: 3-5 business days. Other areas: 5-7 business days. Tracking link sent to your WhatsApp once shipped!"`;




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

  trimMessagesToTokenBudget(messages, budgetChars = 8000) {
    // Keep system prompt always; drop oldest context messages if over budget
    const systemMsg = messages[0];
    const rest = messages.slice(1);
    let totalChars = JSON.stringify(systemMsg).length;
    const kept = [];

    for (let i = rest.length - 1; i >= 0; i--) {
      const msgChars = JSON.stringify(rest[i]).length;
      if (totalChars + msgChars > budgetChars) break;
      totalChars += msgChars;
      kept.unshift(rest[i]);
    }
    return [systemMsg, ...kept];
  }

  async callLLMWithRetry(messages, client, provider = 'groq') {
    const trimmed = this.trimMessagesToTokenBudget(messages);
    const MAX_ATTEMPTS = 4;

    const model = provider === 'openai'
      ? (config.openai?.model || 'gpt-4o-mini')
      : (config.groq?.model || 'llama-3.3-70b-versatile');

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
          max_tokens: 800,
          temperature: attempt <= 2 ? 0.7 : 0.2
        }));
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
        const isToolLeak = err?.error?.code === 'tool_use_failed';
        if ((isRateLimit || isServerErr || isToolLeak) && attempt < MAX_ATTEMPTS) {
          const errLabel = isRateLimit ? 'rate limited' : isToolLeak ? 'tool_use_failed' : 'server error';
          const delay = isRateLimit ? attempt * 4000 : attempt * 3000;
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

    const MAX_ATTEMPTS = 2;
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
            }]
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
          }]
        };
      } catch (err) {
        const isRetryable = err.status === 429 || err.status === 500 || err.status === 503 || err?.message?.includes('RATE_LIMIT');
        if (isRetryable && attempt < MAX_ATTEMPTS) {
          console.warn(`[AI Service] Gemini rate limited/error (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in 3s...`);
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

    // Convert OpenAI-style tools to Gemini function_declarations
    const openaiTools = this.getTools();
    const geminiTools = openaiTools.length > 0 ? [{
      functionDeclarations: openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: {
          type: t.function.parameters.type?.toUpperCase() || 'OBJECT',
          properties: t.function.parameters.properties || {},
          required: t.function.parameters.required || []
        }
      }))
    }] : undefined;

    return { systemMsg, geminiHistory, lastUserMsg, geminiTools };
  }

  /**
   * Call LLM with automatic fallback chain: Groq → OpenAI → Gemini.
   * If a provider is rate-limited or unavailable, transparently switches to the next.
   */
  async callLLMWithFallback(messages) {
    // Build a flat list of all API clients across all providers for key rotation.
    // Order: Groq key1 → Groq key2 → ... → OpenAI key1 → OpenAI key2 → ... → Gemini key1 → ...
    const entries = [];
    for (let i = 0; i < this.groqClients.length; i++) {
      entries.push({ name: 'groq', client: this.groqClients[i], type: 'openai', keyIndex: i });
    }
    for (let i = 0; i < this.openaiClients.length; i++) {
      entries.push({ name: 'openai', client: this.openaiClients[i], type: 'openai', keyIndex: i });
    }
    for (let i = 0; i < this.geminiClients.length; i++) {
      entries.push({ name: 'gemini', client: this.geminiClients[i], type: 'gemini', keyIndex: i });
    }

    if (entries.length === 0) {
      throw new Error('All LLM providers failed — no API keys configured');
    }

    let lastError = null;
    let groqQuotaError = null;

    for (const entry of entries) {
      try {
        let result;
        if (entry.type === 'gemini') {
          result = await this.callWithThrottle(() => this.callGemini(messages, entry.client));
        } else {
          result = await this.callLLMWithRetry(messages, entry.client, entry.name);
        }

        // Update active provider tracking
        const keySuffix = entry.keyIndex > 0 ? `[${entry.keyIndex}]` : '';
        if (this.activeProvider !== entry.name || this.activeKeyIndex !== entry.keyIndex) {
          console.log(`[AI Service] Switched LLM provider: ${this.activeProvider}[${this.activeKeyIndex}] → ${entry.name}${keySuffix}`);
          this.activeProvider = entry.name;
          this.activeKeyIndex = entry.keyIndex;
        }
        return result;
      } catch (err) {
        // Track Groq quota exhaustion separately so we can schedule a retry
        // if ALL providers AND all keys fail.
        if (entry.name === 'groq' && err.isQuotaExhausted) {
          groqQuotaError = err;
          const keySuffix = entry.keyIndex > 0 ? `[${entry.keyIndex}]` : '';
          console.warn(`[AI Service] Groq${keySuffix} quota exhausted, trying next key/provider...`);
          continue;
        }
        lastError = err;
        const keySuffix = entry.keyIndex > 0 ? `[${entry.keyIndex}]` : '';
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

  scheduleQuotaRetry(senderId, userQuery, customerName, customerPhone, waitMs) {
    const delay = waitMs + 20000; // 20s buffer past Groq's stated reset time
    const retryAt = Date.now() + delay;

    // Persist to database so the retry survives server restarts
    dbService.savePendingRetry(senderId, userQuery, customerName, customerPhone, retryAt).catch(() => {});

    console.log(`[AI Service] Scheduling persistent quota retry for ${senderId} in ${Math.round(delay / 1000)}s (retryAt: ${new Date(retryAt).toISOString()})`);

    // Also schedule an in-memory setTimeout for immediate execution when the time comes
    setTimeout(async () => {
      try {
        const retryResponse = await this.answerQuery(senderId, userQuery, customerName, customerPhone);
        // Only send the reply if WhatsApp is still connected
        if (whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
          await whatsappWebBot.client.sendMessage(senderId, retryResponse.replyText);
          console.log(`[AI Service] Sent delayed quota-retry reply to ${senderId}`);
        }
        // Clean up the persisted retry regardless
        dbService.deletePendingRetry(senderId, userQuery).catch(() => {});
      } catch (err) {
        console.error('[AI Service] Quota retry failed:', err.message);
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
        try {
          const retryResponse = await this.answerQuery(
            entry.senderId,
            entry.userQuery,
            entry.customerName,
            entry.customerPhone
          );
          if (whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
            await whatsappWebBot.client.sendMessage(entry.senderId, retryResponse.replyText);
            console.log(`[AI Service] Persistent retry reply sent to ${entry.senderId}`);
          }
          await dbService.deletePendingRetry(entry.senderId, entry.userQuery);
          // Stagger retries to avoid flooding the API
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.error(`[AI Service] Persistent retry failed for ${entry.senderId}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[AI Service] processPendingRetries error:', err.message);
    }
  }

  async answerQuery(senderId, userQuery, customerName = null, customerPhone = null) {
    const session = await dbService.getSession(senderId);
    if (customerName && customerName !== 'Customer') session.customerName = customerName;
    if (customerPhone) session.customerPhone = customerPhone;

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

    if (this.groqClients.length === 0 && this.openaiClients.length === 0 && this.geminiClients.length === 0) {
      resultText = "I'm currently undergoing maintenance. Please reach out to our support number directly on WhatsApp.";
      return { replyText: resultText, intent: 'error', requiresEscalation: false, suggestedProductIds: [] };
    }

    // --- Pre-AI FAQ Matcher ---
    // Answer common FAQ queries directly WITHOUT using any LLM tokens (faster, zero leak risk).
    // CRITICAL: Only run when session is IDLE — NOT during an active order flow where
    // the user might be specifying a size ("M"), address, or confirming an order.
    const isIdle = !session.state || session.state === 'IDLE';
    if (isIdle && session.cart.length === 0 && userQuery) {
      const faqMatches = faqService.searchFAQs(userQuery);
      if (faqMatches.length > 0) {
        const answer = faqMatches[0].answer;
        session.history.push({ role: 'user', content: userQuery });
        session.history.push({ role: 'assistant', content: answer });
        await dbService.saveSession(senderId, session);
        return { replyText: answer, intent: 'faq', requiresEscalation: false, suggestedProductIds: [] };
      }
    }

    let messages = [
      { role: "system", content: this.generateSystemPrompt(session) }
    ];

    for (const msg of session.history) {
      messages.push({ role: msg.role, content: msg.content || "" });
    }
    messages.push({ role: "user", content: userQuery });

    let keepLooping = true;
    let loops = 0;

    while (keepLooping && loops < 5) {
      loops++;
      try {
        const completion = await this.callLLMWithFallback(messages);

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
              session.addressDetails = { name: args.name, phone: args.phone, address: args.address, pincode: args.pincode };
              session.address = `${args.name}, ${args.address}, ${args.pincode} | Ph: ${args.phone}`;
              session.customerPhone = args.phone;
              if (args.name && args.name !== 'Customer') session.customerName = args.name;
              // Update customer registry with confirmed phone number
              dbService.saveCustomer(senderId, args.name, args.phone).catch(() => {});

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
                toolResultObj = { status: "success", message: "Address saved. Show the full order summary (items, sizes, quantities, total price) and ask them to reply YES to confirm." };
              }
            } else if (fnName === "escalate_to_human") {
              requiresEscalation = true;
              session.requiresEscalation = true;
              session.state = 'IDLE';
              session.escalationDetails = {
                reason: args.reason,
                name: args.customerName,
                phone: args.customerPhone,
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
          // Groq Bug Fix: strip all known leaked tool-call formats
          resultText = resultText.replace(/<?\/?function=.*?>.*?<\/function>/gs, '').trim();
          resultText = resultText.replace(/[a-zA-Z_]+>\s*\{.*?\}/gs, '').trim();
          // JSON-style leak — handles one level of nested braces e.g. {"type":"function","parameters":{"topic":"..."}}
          resultText = resultText.replace(/\{"type"\s*:\s*"function"(?:[^{}]|\{[^{}]*\})*\}/g, '').trim();
          // Bare "toolName{...}" or "toolName(...)" leak — no wrapper tags at all, just the raw call
          resultText = resultText.replace(/\b(?:search_products|update_cart|set_shipping_address|escalate_to_human|confirm_order)\s*\(?\s*\{[\s\S]*?\}\)?/g, '').trim();
          // Catch any remaining garbage (orphaned braces/punctuation from partial strip)
          if (!resultText || /^[\s{}\[\],"':]+$/.test(resultText)) {
            resultText = "Sorry about that! 🙏 Could you tell me again what you're looking for? I'll sort you out right away.";
          }
          keepLooping = false;
        }
      } catch (err) {
        if (err.isQuotaExhausted) {
          console.warn(`[AI Service] Groq daily token quota exhausted. Will retry this message in ${Math.round(err.waitMs / 1000)}s.`);
          quotaExhaustedWaitMs = err.waitMs;
          resultText = "Hey! 🙏 We're getting a lot of messages right now - give me just a few minutes and I'll personally get back to you with an answer. Thanks for your patience!";
        } else {
          console.error('[AI Service] Groq API error:', err.error ? JSON.stringify(err.error) : err.message || err);
          resultText = "Sorry about that! 🙏 I had a little trouble just now - could you tell me again which jersey, size, and quantity you're looking for? I'll get you sorted right away.";
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
      suggestedProductIds: []
    };
  }
}

const aiService = new AIService();
export default aiService;

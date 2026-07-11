# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the server
npm start

# Sync products from WooCommerce API to local cache
npm run sync

# Run AI agent tests (single-turn + multi-turn sales funnel simulation)
npm run test-agent

# Run a single ad-hoc query through the AI agent
node src/test_agent.js "Do you have Barcelona jerseys?"

# Run WhatsApp/Telegram test scripts
npm run test-whatsapp
npm run test-telegram

# Semi-automated conversation review — flags likely-problem conversations
# (fallback/error message appeared, customer repeated same question, abandoned mid-purchase)
npm run review
```

## Environment Setup

Create a `.env` file in the root with:

```
GROQ_API_KEY=              # Required: Groq API key for LLaMA inference
GROQ_MODEL=                # Optional: defaults to llama-3.3-70b-versatile
OPENAI_API_KEY=            # Optional: OpenAI fallback (GPT-4o-mini)
GEMINI_API_KEY=            # Optional: Gemini fallback (Gemini 2.0 Flash)
WOOCOMMERCE_URL=           # Required: https://theaurax.in
WOOCOMMERCE_CONSUMER_KEY=
WOOCOMMERCE_CONSUMER_SECRET=
WHATSAPP_WEB_ENABLED=true
OWNER_WHATSAPP_NUMBER=     # Owner's WhatsApp for escalation alerts
BULK_ORDER_THRESHOLD=10    # Qty threshold for bulk order escalation (default)
TELEGRAM_BOT_TOKEN=        # Optional: owner alerts via Telegram
TELEGRAM_CHAT_ID=
GOOGLE_SHEETS_ID=          # Optional: for lead logging
MONGODB_URI=               # Optional: MongoDB for persistent sessions (JSON fallback used if absent)
BASE_URL=http://localhost:3000
ALLOWED_TEST_NUMBERS=      # Comma-separated numbers for safe-mode (only these get replies)
PORT=3000
```

Google Sheets requires a `credentials.json` service account file in the project root.

## Architecture

This is a WhatsApp AI sales bot for **Theaurax.in** (football jerseys). It runs as an Express server and uses `whatsapp-web.js` to connect to WhatsApp via a headless Puppeteer browser session.

### Request Flow

1. A WhatsApp message arrives → `whatsapp-web-bot.js` queues it (concurrency 5 via `async.queue`)
2. The queue handler calls `aiService.answerQuery()`
3. **FAQ Matcher** — If session is IDLE, common FAQ queries are answered instantly from `faq.json` with ZERO LLM calls
4. If not an FAQ → `ai.js` manages a multi-turn agentic loop (up to 5 iterations) with **triple fallback chain**: Groq → OpenAI → Gemini
5. The AI calls tools (`search_products`, `update_cart`, `set_shipping_address`, `confirm_order`, `escalate_to_human`) which are executed server-side
6. On order confirmation, `invoice.js` generates a branded PDF proforma invoice served at `/invoices/`
7. Bulk orders (≥ threshold qty) trigger `sendEscalationAlert()` which notifies the owner via WhatsApp + Telegram
8. First-contact leads are logged to Google Sheets via `sheets.js`
9. Session state and leads are persisted to MongoDB or JSON files in `src/data/`
10. On quota exhaustion, the query is saved to a **persistent retry queue** (JSON/MongoDB) and retried once the quota resets

### Key Services

| File | Purpose |
|------|---------|
| `src/services/ai.js` | Core AI agent — system prompt, tool definitions, agentic loop, FAQ matcher, triple fallback, throttling |
| `src/services/whatsapp-web-bot.js` | WhatsApp Web client lifecycle and message handling |
| `src/services/woocommerce.js` | WooCommerce product sync and local token-scored search |
| `src/services/db.js` | Session + lead + retry queue persistence (MongoDB or JSON files) |
| `src/services/invoice.js` | PDFKit-based proforma invoice generation |
| `src/services/sheets.js` | Google Sheets lead logging (first-contact only) |
| `src/services/telegram.js` | Telegram owner alert notifications |
| `src/services/faq.js` | FAQ search from `src/data/faq.json` |
| `src/services/followup.js` | Cold-lead re-engagement (every 30 min, max 2 follow-ups) |
| `src/config/config.js` | Centralised config with env-var fallbacks |
| `src/review_conversations.js` | Semi-automated review — flags conversations with fallback/error replies, repeated customer questions, or an abandoned mid-purchase cart for human review. Run via `npm run review`. |

### LLM Fallback Chain

```
Groq (LLaMA 3.3-70B)      → Primary provider
  ↓ quota or error
OpenAI (GPT-4o-mini)       → Fallback #1
  ↓ quota or error
Gemini (Gemini 2.0 Flash)  → Fallback #2
  ↓ all fail
Friendly error message + persistent retry scheduling
```

### Session State Machine

Sessions progress through: `IDLE → COLLECTING_ADDRESS → CONFIRMING_ORDER → IDLE`

On `confirm_order`, a real WooCommerce order is created via REST API (`woocommerce.createOrder()`). The customer receives a direct payment URL (`/checkout/order-pay/{id}/?pay_for_order=true&key={key}`) to complete checkout. If WooCommerce order creation fails, the bot falls back to a PDF invoice.

The cart holds only one product at a time (replaced on each `update_cart` call).

### Deterministic Fast Paths (Zero LLM Calls)

Three of the highest-frequency conversational turns are handled entirely in code — no LLM call, no rate-limit exposure, no hallucination risk:

1. **FAQ matching** (`faq.js` + pre-check in `ai.js`) — common questions (COD, shipping, sizing, returns, customization, bulk, tracking, cancellation, kids sizes, jersey care, international shipping) answered instantly from `faq.json`. Only runs when session is `IDLE` with an empty cart.
2. **Size + quantity parsing** (`aiService.parseSizeQtyReply()`) — replies like `"M size 2"`, `"1st one, L 3"`, or `"XL"` are regex-parsed against `session.lastShownProducts` (populated whenever `search_products` runs) and go straight to cart via `update_cart` logic. Returns `null` on anything not confidently parseable — including trusting only sizes the matched product actually lists — and falls through to the LLM in that case. Intent tag: `deterministic_cart`.
3. **Order confirmation** (`aiService._confirmOrderNow()`) — a message that IS ENTIRELY a confirmation word/phrase (`"yes"`, `"confirm"`, `"seri"`, `"ok"`, etc. — anchored full-string match, not substring) during `CONFIRMING_ORDER` state creates the order directly. `"yes but change the address"` still goes to the LLM since it isn't purely a confirmation. Intent tag: `deterministic_confirm`.

A fourth optimization saves an LLM call without skipping it entirely: when `search_products` returns exactly one confident match, the reply is templated directly (randomized hype opener + product details) instead of feeding the result back for a second "narration" LLM call. Multiple matches still get narrated normally so the model can help the customer choose.

Together these cut LLM calls roughly in half on a typical size→address→confirm purchase flow, which matters because free-tier API quotas (Groq/Gemini) are shared across every concurrent customer — every call avoided is capacity freed up for everyone else.

### Customer Registry

Every customer interaction upserts a record in `src/data/customers.json` (or MongoDB `customers` collection). Use `dbService.getAllCustomers()` to retrieve all contacts for product launch campaigns or bulk messaging.

### Cold Lead Follow-Up

`src/services/followup.js` runs a check every 30 minutes. Any active lead inactive for 3+ hours (up to 2 times) gets a personalized re-engagement message via WhatsApp. Cart contents are referenced in the message if available.

### Product Cache

`src/data/products_cache.json` is a local snapshot of WooCommerce products, including `total_sales` (synced from WooCommerce). Run `npm run sync` to refresh it. The search uses token-matching with relevance scoring — no embeddings or vector DB. Queries with genuine keyword/category relevance are scored and ranked; stock status is only a tiebreaker among already-relevant matches, never a standalone qualifier (a prior bug had every in-stock product score >0 regardless of relevance, so a query with zero real keyword overlap returned ~10 arbitrary products instead of falling back cleanly). "Best selling / popular / trending" queries are detected and ranked by `total_sales` instead of falling through to the generic relevance path.

### WhatsApp Connection

On first run, visit `http://localhost:3000/whatsapp-link.html` to scan the QR code. Auth is persisted in `.wwebjs_auth/` (Puppeteer LocalAuth). The bot auto-reconnects on disconnect with a 10-second delay.

### Safe Mode

If `ALLOWED_TEST_NUMBERS` is set, the bot only responds to those phone numbers — useful for staging.

### Monitoring Endpoints

| Route | Description |
|---|---|
| `GET /api/whatsapp/status` | WhatsApp Web connection state + QR code |
| `GET /api/retry-stats` | Pending retry queue, provider status, active provider |

### Rate-Limit Protection

- **Throttle**: Per-(provider, key) min gap, not just per-provider — each of the 5 Groq keys has its own timer (`AIService.minApiGapMs` / `lastApiCallTimes` keyed by `provider#keyIndex`), so multiple keys give real parallel throughput instead of sharing one timer.
- **Key rotation**: Round-robin starting key per provider (`rotateEntries()`) so concurrent requests spread across keys instead of every request hammering key[0] first.
- **Retry**: 4 attempts with exponential backoff for 429/500/503 *and* Groq's `tool_use_failed` (malformed tool-call generation, usually transient).
- **Quota**: Daily quota exhaustion is tracked **per key** (`keyExhaustedUntil`), not per provider — one exhausted Groq key no longer benches its sibling keys. Persistent retry queue (DB-backed) survives restarts; entries are only kept alive across a restart if the retry itself re-exhausts quota, otherwise they're always cleared (this used to leak on send failure and replay forever — fixed).
- **Concurrency**: WhatsApp messages are chained **per sender** (not a flat concurrency-N pool) — same customer's messages are processed strictly in order to avoid session read-modify-write races (e.g. "size M" then "qty 3" sent seconds apart used to be able to clobber each other); different customers still run fully in parallel.
- **Message trimming** (`trimMessagesToTokenBudget()` in `ai.js`): char-budget trims the oldest messages when a conversation gets long, but always keeps at least the single most recent message/tool-call-pair regardless of budget — a `tool` result message is only valid immediately after the assistant message that issued its `tool_calls`, so they're trimmed as one atomic group, never split. Without this, a single large `search_products` tool result (full product JSON) could exceed the budget and get dropped along with the user's actual question, leaving the model just the bare system prompt — some models (Qwen) correctly rejected that outright, others (Llama) silently improvised a generic answer with zero real context.

### Language Handling (Tanglish vs English)

Language is detected deterministically in code (`detectLanguage()` in `ai.js`) via Tamil-script/keyword matching — not left to the LLM to guess each turn. It's decided once and locked into `session.language` for the whole conversation. For Tanglish sessions, Gemini is tried before Groq in the fallback chain (noticeably better at natural Tamil-English code-mixing than Llama-3.3); English sessions keep Groq first.

**Qwen3 experiment (2026-07-11, reverted):** Tried routing Tanglish sessions to `qwen/qwen3.6-27b` on Groq's free tier (`config.groq.tanglishModel`) for better code-mixing quality than Llama-3.3. Genuinely better output quality when it worked, but Groq's free tier caps Qwen at **8000 TPM per key** — a single request on this bot's system prompt + tool-result payload can already consume most of that, and a real multi-turn test conversation exhausted 2 of 5 keys' entire *daily* quota and took 5-6 minutes on one turn. Not viable for concurrent real traffic. Reverted to `null` (falls back to `config.groq.model`, i.e. Llama-3.3) by default — the code path (dynamic `max_tokens` sizing, `reasoning_format: 'hidden'` to suppress `<think>` leakage, tool-call-pair-aware message trimming) is still there and works, just gated behind explicitly setting `GROQ_TANGLISH_MODEL` in `.env` if you upgrade to Groq's paid Dev Tier later.

### Implemented 2026-07-11: LLM call reduction

All five ideas below (previously "planned, not yet implemented") are now built:
1. ✅ Expanded FAQ coverage in `faq.json` — added order tracking, shipping coverage (India-only), jersey care/washing, cancellation, kids jerseys. Also removed the bare `"m"`/`"l"`/`"xl"`/`"xxl"`/`"name"`/`"number"` FAQ keywords, which were false-matching on customers stating their size or phone number mid-order and hijacking them away from the AI agent.
2. ✅ Removed the full FAQ block from the system prompt (`generateSystemPrompt()` in `ai.js`) — the code-level FAQ matcher already covers idle-state queries; the prompt now just briefly points at that instead of embedding every Q&A. Cut the prompt from ~7000 to ~4500 JSON chars.
3. ✅ Deterministic order-confirmation bypass — see "Deterministic Fast Paths" above.
4. ✅ Deterministic size+quantity parsing — see "Deterministic Fast Paths" above.
5. ✅ Single-match product lookups are now templated instead of triggering a second narration call — see "Deterministic Fast Paths" above.

Improving the bot from real conversation failures over time: storing conversations in a database and periodically reviewing them is a good idea and worth doing regardless. But "fine-tuning"/training the model weights on that data is a heavier, riskier path — Groq (the primary provider) doesn't offer fine-tuning for its hosted models at all, and fine-tuning OpenAI/Gemini requires a carefully curated dataset (raw failure logs are the wrong training data — they'd reinforce the same mistakes unless first corrected into ideal examples), real cost, and risk of making the model worse elsewhere if the dataset is small. The practical equivalent that gets the same real benefit safely: periodically review real conversations for failures and patch the system prompt/FAQ/product aliases/guardrails based on what's found (this is literally how the greeting-leak bug and the Tanglish routing fix were found and fixed this session, from old conversation logs).

✅ **Implemented**: `npm run review` (`src/review_conversations.js`) flags conversations with a fallback/error reply, a repeated customer question, or an abandoned mid-purchase cart — reads via `dbService.getAllLeads()` (works against MongoDB if `MONGODB_URI` is set, JSON fallback otherwise; no new code needed for either). First real run flagged a genuine bug worth investigating: several distinct sessions show `"Do you have Real Madrid jerseys?"` being answered with the generic greeting FAQ 2-3 times in a row instead of a product search — looks related to (or a recurrence of) the earlier greeting-leak issue. Not yet root-caused. Deciding the actual fix from a review run stays a manual, one-time small edit — not model retraining.

### Open item as of 2026-07-11 (needs a decision, see `theaurax_context.md` for full detail)
Gemini free tier is returning `limit: 0` on every metric (per-minute AND per-day), confirmed reproducible on a **brand-new key from a different Google account/project** — not a per-account overuse issue, looks like a systemic free-tier eligibility restriction. More free keys won't fix it. Also confirmed OpenRouter's free Gemini tier no longer exists at all (checked July 2026 — every Gemini model there is now paid). Also tried Qwen3 on Groq's free tier as a Tanglish-quality alternative — see "Qwen3 experiment" above — works but its 8000 TPM/key cap can't handle real concurrent traffic, reverted to off by default. Choice is still between enabling billing on a Google Cloud project (cheap at this bot's volume) or deprioritizing Gemini and relying on Groq/Llama-3.3 (already confirmed working at real production volume, including Tanglish, just without Gemini/Qwen's better code-mixing quality). A third option surfaced this session: Claude Haiku via the Anthropic API — not free, but no shared-free-tier ceiling to worry about at this bot's scale, and strong Tanglish/code-mixed quality. Not yet implemented, would need an explicit decision to add a new paid provider.

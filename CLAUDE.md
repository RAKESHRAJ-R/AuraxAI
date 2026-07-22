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

# Build the unified admin console (Vite + React → admin/dist, served at /admin)
npm run build-admin

# One-time migrate local JSON data → MongoDB (needs MONGODB_URI in .env)
npm run migrate-mongo
```

## Environment Setup

Create a `.env` file in the root with:

```
GROQ_API_KEY=              # Required: Groq API key for LLaMA inference
GROQ_MODEL=                # Optional: defaults to llama-3.3-70b-versatile
OPENAI_API_KEY=            # Optional: OpenAI fallback (GPT-4o-mini)
GEMINI_API_KEY=            # Optional: Gemini fallback (Gemini 2.0 Flash)
FIREWORKS_API_KEY=         # Optional: Fireworks paid fallback (comma-sep for multiple keys)
FIREWORKS_MODEL=           # Optional: defaults to accounts/fireworks/models/deepseek-v4-pro
SARVAM_API_KEY=            # Optional: Sarvam (Indic-native) paid provider — Tanglish-first (comma-sep for multiple keys)
SARVAM_MODEL=              # Optional: defaults to sarvam-30b
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
KNOWLEDGE_HUB_PASSWORD=    # Optional: shared password for the /knowledge-hub.html admin page (unset = hub disabled)
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
English sessions:
Groq (LLaMA 3.3-70B)           → Primary provider (fast, free)
  ↓ quota or error
Fireworks (deepseek-v4-pro)    → First paid fallback (no shared free-tier ceiling)
  ↓ quota or error
Sarvam (sarvam-30b)            → Second paid fallback
  ↓ quota or error
OpenAI → OpenRouter → Gemini   → Further fallbacks
  ↓ all fail
Friendly error message + persistent retry scheduling

Tanglish sessions:
Sarvam (sarvam-30b)            → Tried FIRST — Indic-native, purpose-trained on romanized/code-mixed Tamil
  ↓ quota or error
Fireworks (deepseek-v4-pro)    → Paid backup (also strong at code-mixing)
  ↓ quota or error
Groq (LLaMA 3.3-70B)           → Fast free backstop, then OpenAI → OpenRouter → Gemini
```

**Sarvam provider (added 2026-07-20):** Indic-specialised paid provider (Sarvam AI, India),
OpenAI-compatible (`baseURL: https://api.sarvam.ai/v1`, `Authorization: Bearer` — wired exactly
like Fireworks). Uses `sarvam-30b` (64K ctx; `sarvam-105b` also available via `SARVAM_MODEL`).
`sarvam-30b`/`105b` are purpose-trained on native-script, romanized AND code-mixed Indian-language
text (Tamil included), so this takes the **Tanglish-first** slot ahead of Fireworks — the specific
weakness Llama-3.3 has. **`sarvam-30b` IS a reasoning model (verified live 2026-07-22 — the earlier
"not a reasoning model" note from the vendor docs was wrong).** By default it spends the entire
`max_tokens` budget on an internal chain-of-thought (returned in a separate `reasoning_content`
field) and leaves the visible `content` null/truncated — at `max_tokens` 800 AND 1500 `content` came
back null (`finish_reason: 'length'`); only ~2500 let it finish, at ~1400 tok/reply. **Fix in
`ai.js`: append the `/no_think` control tag to the system message for Sarvam only** — this disables
the reasoning pass entirely and returns the same clean Tanglish answer AND full tool-calling in
~100-180 tokens, so the normal `max_tokens` (800) budget is kept. Full OpenAI-style tool calling
confirmed live in the agentic loop. ~₹360/mo at 100 convos/day (cheaper than Fireworks), with a
₹1,000 signup credit covering ~12,000 convos before any payment. Gated behind `SARVAM_API_KEY` —
absent = provider simply isn't loaded, chain degrades cleanly to Fireworks/Groq. **Activated
2026-07-22:** key is in `.env`; live Tanglish call, tool-calling, and full `answerQuery` flow all
verified. Chosen per the 2026-07-15 provider research report
(`reports/LLM_Provider_Research_2026-07-15.pdf`), which recommended Sarvam over
Fireworks/Cerebras/NVIDIA-NIM for the Tanglish requirement.

**Fireworks provider (added 2026-07-17):** Client-supplied paid key, OpenAI-compatible
(`baseURL: https://api.fireworks.ai/inference/v1`), wired exactly like OpenRouter. Uses
`deepseek-v4-pro` — a reasoning model that returns the final answer cleanly in `content`
(no `reasoning_format` flag needed) but needs headroom, so `max_tokens` is 1500 for
Fireworks vs 800 for non-reasoning providers. Verified live: tool-calling works in the full
agentic loop, Tanglish quality clearly beats Llama-3.3, ~₹0.01–0.02/reply. Fireworks takes
the Tanglish-first slot that dead Gemini (`limit:0`) used to hold. Gated behind
`FIREWORKS_API_KEY` — absent = provider simply isn't loaded, no behavior change. A standalone
smoke test lives at `test_fireworks.js` (probes auth, available models, tool-calling, Tanglish).

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

### Knowledge Hub (client-editable, self-service bot corrections)

A Wati-KnowBot-style feature: the store owner teaches the bot the right answers through a web
page, and corrections go live immediately — **no code change, no deploy, no dev**. Added
2026-07-20. Runs on the existing JSON-or-Mongo `dbService` pattern (JSON by default; set
`MONGODB_URI` to use Mongo — no code change either way).

**Flow:** (now a section of the unified admin console — `/admin/knowledge`, see "Admin Console")
1. Owner opens `/admin`, logs in with `KNOWLEDGE_HUB_PASSWORD` (single shared password →
   in-memory bearer token), and goes to the **Knowledge Hub** section.
2. **Teach tab:** add/edit/delete answers — `{ keywords[], question, answer, language, active }`.
   Auto-diagnosed "needs answer" drafts (see below) surface here at the top.
3. **Review tab:** surfaces likely-problem conversations (same heuristics as `npm run review`:
   fallback/error reply, repeated question, abandoned cart) with a "Teach the right answer"
   button that pre-fills the form from the customer's actual message.

**Auto-diagnosis / "needs answer" queue (added 2026-07-22, `src/services/diagnose.js`):**
`diagnoseUnanswered()` scans conversations for teachable gaps (the REVIEW heuristics — NOT
runtime LLM/quota failures, which are infra, not teachable) and materialises each as an
**inactive** knowledge draft (`source:'auto', active:false, empty answer, hits` counter,
auto keywords, guessed language) via `dbService.saveUnansweredDraft()` (dedup by normalized
question; bumps `hits` on repeat). Because `active:false`, the matcher never serves a blank
draft. Runs 20s after boot then every 30 min (`alert:true` → owner WhatsApp+Telegram ping on
NEW gaps via `sendKnowledgeGapAlert`), and on-demand when the Teach tab opens (`alert:false`).
The sidebar shows a **pending-count badge**. Answering a draft flips it to a live `manual`
entry; **Dismiss** is a permanent tombstone (`dismissed:true`) so the scan never re-queues it
(a plain delete would just get regenerated next scan). Extra endpoints:
`GET /api/knowledge/pending-count`, `POST /api/knowledge/diagnose`,
`POST /api/knowledge/:id/dismiss` (all auth). Dismissed tombstones are hidden from the list
(`GET /api/knowledge` filters them) and excluded from the badge count.

**How the bot consumes it** (`knowledge.js` matcher, hooked into `answerQuery`):
- Token/keyword-scored match (mirrors `faq.js`) with two confidence tiers, language-scoped.
- **Confident match** (a phrase keyword or ≥2 single-token keywords) → answered **directly,
  zero LLM**, runs BEFORE the static FAQ matcher so a client correction always wins. Intent
  tag: `knowledge`.
- **Soft match** → the entry is injected into the LLM call as a separate `VERIFIED BUSINESS
  KNOWLEDGE` system message (placed right before the user message so it survives token trimming
  and does NOT break the cacheable system-prompt prefix), so the model prefers the owner's
  guidance over its own guess. Zero token cost when there's no match.
- `knowledgeService.invalidate()` is called on every write so edits are live without a restart
  (also a 60s TTL safety re-read).

**Files:** `src/services/knowledge.js` (matcher) + `src/services/diagnose.js` (auto-queue),
`dbService` knowledge CRUD + `src/data/knowledge.json` fallback store (MongoDB when
`MONGODB_URI` set), knowledge hook in `ai.js answerQuery`, API + shared-password auth + review
+ diagnose endpoints in `src/index.js`, UI in the `admin/` React app (`pages/Knowledge.jsx`).
Endpoints: `POST /api/knowledge-hub/login`, `GET/POST /api/knowledge`, `DELETE /api/knowledge/:id`,
`GET /api/knowledge/review`, `GET /api/knowledge/pending-count`, `POST /api/knowledge/diagnose`,
`POST /api/knowledge/:id/dismiss` (all but login require the bearer token).

Verified 2026-07-20: a seeded correction changed a live `answerQuery` reply (intent `knowledge`,
zero LLM); all API auth paths (wrong/right password, missing token, CRUD, review over 60 real
leads) pass; the React page renders in headless Chrome with zero console errors.

### Customer Registry

Every customer interaction upserts a record in `src/data/customers.json` (or MongoDB `customers` collection). Use `dbService.getAllCustomers()` to retrieve all contacts for product launch campaigns or bulk messaging.

### Cold Lead Follow-Up

`src/services/followup.js` runs a check every 30 minutes. Any active lead inactive for 3+ hours (up to 2 times) gets a personalized re-engagement message via WhatsApp. Cart contents are referenced in the message if available.

### Product Cache

`src/data/products_cache.json` is a local snapshot of WooCommerce products, including `total_sales` (synced from WooCommerce). Run `npm run sync` to refresh it. The search uses token-matching with relevance scoring — no embeddings or vector DB. Queries with genuine keyword/category relevance are scored and ranked; stock status is only a tiebreaker among already-relevant matches, never a standalone qualifier (a prior bug had every in-stock product score >0 regardless of relevance, so a query with zero real keyword overlap returned ~10 arbitrary products instead of falling back cleanly). "Best selling / popular / trending" queries are detected and ranked by `total_sales` instead of falling through to the generic relevance path.

### WhatsApp Connection

On first run, open the admin console at `http://localhost:3000/admin`, sign in, and go to the **WhatsApp** section (`/admin/whatsapp`) to scan the QR code. Auth is persisted in `.wwebjs_auth/` (Puppeteer LocalAuth). The bot auto-reconnects on disconnect with a 10-second delay. (The old `/whatsapp-link.html` URL now 302-redirects to `/admin/whatsapp`.)

### Admin Console (unified Vite + React app)

Added 2026-07-22. The three former standalone pages (`apiwork.html` monitor, `whatsapp-link.html`
QR link, `knowledge-hub.html`) are consolidated into **one** proper React SPA under `admin/`
(Vite build, react-router, react-chartjs-2) — light/clean/professional theme, mobile + desktop
responsive, with a sidebar: **Monitor · WhatsApp · Knowledge Hub**. It is **all behind one login**
(the existing `KNOWLEDGE_HUB_PASSWORD` bearer-token flow), so the monitor and QR — previously open
to anyone with the URL — are now protected too (`/api/provider-stats`, `/api/sessions`, `/api/logs`,
`/api/whatsapp/status`, `/api/retry-stats` all require the token).

- **Source:** `admin/` (its own npm package: `src/{main.jsx,App.jsx,contexts.jsx,api.js,styles.css}`,
  `src/components/{Login,Layout}.jsx`, `src/pages/{Monitor,WhatsApp,Knowledge}.jsx`).
- **Build:** `cd admin && npm install && npm run build` → outputs `admin/dist/` (committed? see repo).
  Express serves `admin/dist` at `/admin` (`express.static`) with a `/admin/*` fallback to
  `index.html` for client-side routes. **After changing anything in `admin/src`, re-run the build**
  or the served app won't update.
- **Dev:** `cd admin && npm run dev` (Vite on :5174, proxies `/api` + `/invoices` to the bot on :3000).
- The old `.html` URLs 302-redirect to the matching `/admin/*` section; `/` redirects to `/admin`.

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

### Implemented 2026-07-20: Token-per-call reduction (`generateSystemPrompt` in `ai.js`)

Three changes cut input tokens on every call (distinct from the 2026-07-11 work, which cut the *number* of calls). Verified live via `node src/test_agent.js` — tool-calling behaviour unchanged, and the new `[Tokens]` line fires.

1. ✅ **Worked-examples split by session language.** The `WORKED EXAMPLES` block used to send BOTH English and Tanglish variants on every call (~41% of the prompt) even though `session.language` is locked before the prompt is built. Now only the session's language block is emitted; each block was made self-contained (product search, multi-match one-question rule, verbatim payment-link rule, an FAQ) so neither language loses coverage. Measured: English prompt 6,549 → **5,735 chars** (~−232 tok/call), Tanglish → **6,059 chars** (~−140 tok/call). Closes report Finding 2.
2. ✅ **Cache-friendly prompt ordering.** The only per-call-varying content (cart, address) was moved from near the TOP to the very END of the system prompt (now ~98% through). The large static instructions+examples prefix is now byte-identical across all calls within a language, so the OpenAI-compatible providers (Groq, Fireworks, Sarvam) auto-cache it — Sarvam bills cached input ₹1.50/M vs ₹2.50/M. No API param needed; the win is purely from a stable prefix. Keep dynamic session state last.
3. ✅ **Per-call token logging.** Every successful call logs `[Tokens] <provider> model=… lang=… in=<prompt> out=<completion> total=<n> [cached=<n>]`. `prompt_tokens`/`completion_tokens`/`cached_tokens` splits are also accumulated per-provider in `providerStats` (surfaced at `GET /api/retry-stats`) and stored on each `callRecords` entry. This replaces the report's estimated 40k-tok/conversation figure with real production numbers — do this before any volume commitment.

Not adopted (assessed 2026-07-20): **Headroom** (open-source CCR context-compression tool). Built for coding agents dumping huge files/JSON; it compresses tool *outputs*, not the system prompt + tool schema that dominate THIS bot's per-call cost (~57% fixed floor). Its compress-and-retrieve overhead can cost more than it saves on a 2-3 item product list, and it's Python (bot is Node → proxy/MCP hop). The borrowable idea — trim unused fields from the `search_products` result before feeding it back — is a no-dependency alternative if that payload proves fat.

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

# Theaurax AI Sales Assistant — Project Context

## Last Updated
2026-07-22

---

## Session 2026-07-22 — summary
- **Invoice ₹ fix:** bundled DejaVu Sans (has ₹) into `src/assets/fonts/`, registered in
  `invoice.js`; ₹ now renders (was blank under PDFKit's Helvetica). Headings use the real
  bold weight (old `{bold:true}` text options were no-ops).
- **Sarvam live + reasoning fix:** `SARVAM_API_KEY` set. Live testing showed `sarvam-30b` IS a
  reasoning model (docs were wrong) → at `max_tokens` 800 it returned null `content`. Fix in
  `ai.js`: append `/no_think` to the system prompt for Sarvam only → clean Tanglish answer +
  tool-calling in ~100-180 tok, 800 budget kept.
- **Tanglish prompt upgrade:** added a Tanglish-only tone block + negative constraints
  ("enna panna kudadhu") + short worked examples to `generateSystemPrompt()`; English prompt
  unchanged, cache-safe ordering preserved.
- **Unified admin console:** replaced the 3 standalone pages (`apiwork.html`,
  `whatsapp-link.html`, `knowledge-hub.html`) with ONE Vite + React app in `admin/` (light/clean
  responsive theme, sidebar: Monitor · WhatsApp · Knowledge Hub). All behind ONE login; the
  monitor + WhatsApp APIs are now token-protected. Served at `/admin`; old URLs redirect.
- **MongoDB live:** installed `mongodb` driver (was missing → always fell back to JSON), added
  `npm run migrate-mongo`. Migrated 44 sessions / 66 leads / 27 customers into Atlas; verified
  the bot reads from Mongo.
- **Knowledge auto-diagnosis queue:** `diagnose.js` turns struggling conversations into inactive
  "needs answer" drafts (badge count, owner WhatsApp/Telegram alert on new gaps); **Dismiss** is
  a permanent tombstone so drafts don't regenerate; answering makes a draft a live entry.
- `KNOWLEDGE_HUB_PASSWORD` set (hub enabled). `KNOWLEDGE_HUB_PASSWORD`/`SARVAM_API_KEY`/
  `MONGODB_URI` all live in `.env`.

---

## Client
- **Business**: Theaurax.in (retail + wholesale jersey business)
- **Platform**: WordPress + WooCommerce
- **Problem**: Getting huge order inquiries via Instagram DM and WhatsApp after posting reels/videos. Cannot reply instantly. Losing orders.
- **Goal**: AI agent that replies 24/7, converts every chat into a successful order

---

## Solution Overview
AI Sales Assistant that:
1. Receives messages instantly via webhook (Instagram DM + WhatsApp)
2. Classifies the message type
3. Replies automatically based on type
4. Escalates bulk orders to owner
5. Guides customer to checkout on TheAurax.in
6. Sends invoice, tracking, thank-you automatically

---

## Message Classification Logic
```
Customer Message
       ↓
   WhatsApp Web receives instantly (concurrency 5 queue)
       ↓
   Pre-AI FAQ Matcher (IDLE sessions only):
   - COD, shipping, sizing, returns, bulk, customization → Reply from local faq.json instantly (NO AI)
       ↓ (if not FAQ)
   Classify via LLM (Groq → OpenAI → OpenRouter → Gemini fallback chain):
   - General/browsing (what jerseys?) → AI searches WooCommerce product cache & suggests
   - Order intent (size/qty/address) → AI guides through order flow
   - Bulk order (≥ threshold) → Escalate to owner via WhatsApp + Telegram
   - Ready to confirm → Create WooCommerce order / PDF invoice
```

---

## Tech Stack (Current)
| Component | Tool | Notes |
|---|---|---|
| WhatsApp | WhatsApp Web (whatsapp-web.js + Puppeteer) | Linked device, QR auth, auto-reconnect |
| Instagram DM | Meta Graph API | Phase 2 — Instagram service exists but not active |
| Backend | Node.js (Express) | Runs on port 3000 |
| Database | JSON files (src/data/) | MongoDB optional via MONGODB_URI |
| AI Engine | Groq (LLaMA 3.3-70B) → OpenAI (GPT-4o-mini) → OpenRouter → Gemini (2.0 Flash) | Quadruple fallback chain with per-provider throttling |
| Product Catalog | WooCommerce REST API | Products cached locally in products_cache.json |
| Invoice | PDFKit | Branded proforma invoice served at /invoices/ |
| Lead Logging | Google Sheets | First-contact only, via service account |
| Owner Alerts | WhatsApp + Telegram | Bulk order / wholesale escalations |
| Cold Follow-up | Built-in scheduler | Every 30 min, up to 2 follow-ups per lead |

---

## What Is Feasible (100% Buildable)
- WhatsApp webhook + auto-reply
- Message classifier (keyword-based + AI fallback)
- FAQ engine (predefined answers)
- WooCommerce product search and recommendations
- Bulk order alert to owner's WhatsApp
- Order collection via conversation (product, size, qty, address)
- Auto PDF invoice generation
- Send invoice via WhatsApp
- Follow-up message if customer goes cold
- Thank-you + feedback message after delivery
- MongoDB lead/order tracking

## What Has Limitations
| Feature | Limitation | Workaround |
|---|---|---|
| Instagram DM after 24h | Meta policy: only templates after 24h gap | Start WhatsApp first, add Instagram later |
| Product images on Instagram DM | Images must be public URLs | Use WooCommerce image URLs |
| Auto add to cart for customer | WooCommerce cart is session-based | Send direct product/checkout link |
| Real-time tracking | Only if using Shiprocket/Delhivery API | Manual tracking message from owner |
| COD payment collection | Physical cash — AI cannot collect | AI notes COD, human confirms |
| Order packing/shipping | Physical process | Human handles, AI notifies |

---

## Setup Status (Completed ✅ / Pending ⬜)

### From TheAurax.in
- [✅] WooCommerce Consumer Key + Consumer Secret — configured in .env
- [✅] WordPress admin access — available
- [✅] All products listed with prices, sizes, stock, images — 100+ products in cache

### From Their Accounts
- [⬜] Dedicated WhatsApp Business number — using WhatsApp Web linked device instead
- [⬜] Facebook Business Manager account — needed for Instagram DM (Phase 2)
- [⬜] Instagram Business Account linked to Facebook Page — needed for Phase 2
- [⬜] Meta Developer Account access — needed for Phase 2

### Business Information
- [✅] FAQ list — 7 FAQs in src/data/faq.json (COD, shipping, sizing, returns, customization, quality, bulk)
- [✅] Shipping charges — FREE prepaid, ₹50 COD fee
- [✅] Delivery timeline — 3-5 days metro, 5-7 days other
- [✅] COD availability — Yes, with ₹50 fee
- [⬜] Courier partner — not configured yet
- [✅] Owner's WhatsApp number — configured in .env (OWNER_WHATSAPP_NUMBER)
- [✅] Brand info — "Theaurax" branding on invoices
- [✅] Bulk order threshold — set to 10 (BULK_ORDER_THRESHOLD)

---

## Build Phases (Progress)

### ✅ Phase 1 — WhatsApp Bot Core (Complete)
- Set up WhatsApp Web linked device (whatsapp-web.js + Puppeteer) — replacing WATI.io
- Node.js Express server with message queue (concurrency 5)
- Pre-AI FAQ matcher (answers instantly without LLM)
- WooCommerce product cache + token-scored local search (739KB, 100+ products)
- Bulk order escalation to owner (WhatsApp + Telegram)
- Google Sheets lead logging

### ✅ Phase 2 — Order Flow + Invoice (Complete)
- Multi-turn AI agentic loop with 5 tools (search, cart, address, confirm, escalate)
- PDF invoice generation via PDFKit (branded, includes UPI/COD instructions)
- Real WooCommerce order creation via REST API (falls back to PDF if website is down)

### ✅ Phase 3 — Follow-up + Lead Tracking (Complete)
- Persistent storage via JSON files (MongoDB optional)
- Customer registry (48 contacts)
- Cold lead follow-up scheduler (every 30 min, 3hr inactive threshold, max 2 follow-ups)
- Session state machine (IDLE → COLLECTING_ADDRESS → CONFIRMING_ORDER)

### ⬜ Phase 4 — Instagram DM (Not started)
- Meta app review submission needed
- Instagram service exists but in mock mode (no active integration)

### 🆕 Recent Enhancements (July 2026)
- **Triple LLM fallback chain**: Groq → OpenAI → OpenRouter → Gemini
- **Pre-AI FAQ matcher**: Zero LLM calls for common questions
- **Per-provider rate-limit throttling**: Each provider has its own throttle (Groq: 2s, OpenAI: 666ms, OpenRouter: 1s, Gemini: 1.5s)
- **Two-pass tool call stripping**: Eliminates leaked tool syntax from responses
- **Persistent retry queue**: Survives server restarts (DB-backed)
- **Monitoring endpoints**: GET /api/retry-stats, GET /api/provider-stats, POST /api/provider-stats/reset
- **OpenRouter integration**: New fallback provider using OpenRouter API (configurable model via OPENROUTER_MODEL)
- **Provider analytics**: Per-provider success/error/quota exhaustion counters with proactive quota skipping
- **WooCommerce search improvements**: Name aliases (BARZIL→BRAZIL), deduplication, kids/adult filtering, fallback products, in-stock prioritization, plural/singular matching

---

## Current Status

### ✅ Completed & Working
- **Pre-AI FAQ Matcher** (`ai.js`): FAQ queries (COD, shipping, sizing, returns, etc.) are answered **instantly without any LLM call** — zero token cost, zero leak risk. Gated on session state `IDLE` so it won't intercept order messages.
- **Two-Pass Tool Call Stripping** (`ai.js`): When Groq returns leaked text alongside a tool call, the text is discarded immediately — only the tool call is processed.
- **Per-Provider Rate-Limit Throttling** (`ai.js`): Each provider has its own throttle timer and min gap (Groq: 2s, OpenAI: 666ms, OpenRouter: 1s, Gemini: 1.5s). `callWithThrottle(fn, provider)` applies the correct gap per provider.
- **Quadruple LLM Fallback Chain** (`ai.js`): Groq (LLaMA 3.3-70B) → OpenAI (GPT-4o-mini) → OpenRouter (configurable, default `google/gemini-2.0-flash:free`) → Gemini (2.0 Flash). When one provider fails, the next is tried automatically. Multiple API keys per provider are rotated through.
- **Proactive Quota Skipping** (`ai.js`): When a provider's quota is exhausted, its `lastExhaustedAt` timestamp is recorded. Subsequent calls skip that provider until the reset window (~5 min default) passes, avoiding wasted retries.
- **OpenRouter Integration** (`ai.js` + `config.js`): New OpenRouter provider added to the fallback chain. Configured via `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` env vars. Supports key rotation with multiple comma-separated keys.
- **Provider Analytics Stats** (`ai.js` + `index.js`): Per-provider counters tracking success, errors, quota exhaustion, and last error timestamps. Accessible via `GET /api/provider-stats` and resettable via `POST /api/provider-stats/reset`.
- **Gemini Integration** (`ai.js`): Full message format conversion (OpenAI ↔ Gemini) via `_buildGeminiConversation()`. Supports all roles: system, user, assistant with tool_calls, tool with functionResponse. Includes 3-attempt retry loop.
- **Persistent Retry Queue** (`db.js` + `ai.js` + `index.js`): Quota-exhausted queries are saved to DB (MongoDB or JSON) and retried automatically. Survives server restarts. Runs 15s after startup + every 60s.
- **Retry Stats Endpoint** (`index.js`): `GET /api/retry-stats` shows pending retries, due count, provider config status, and active provider.
- **Active Provider Tracking** (`ai.js`): `aiService.activeProvider` reports which LLM is currently handling requests.
- **WooCommerce Product Search Improvements** (`woocommerce.js`): Name aliases (BARZIL→BRAZIL, NETHERLAND→NETHERLANDS), deduplication by normalized name, kids/adult filtering, fallback products when no results found, in-stock prioritization, and plural/singular matching.
- **No-LLM Fallback** (`ai.js`): When ALL LLM providers are exhausted/rate-limited, `_buildNoLLMFallback()` searches the local product cache and returns a helpful response with up to 3 matching products. Zero API calls, zero cost. The retry scheduler still fires when quota resets.
- **Product Search Test Suite** (`test_product_search.js`): Comprehensive 45+ query test covering team names, national teams, players, budgets, categories, edge cases, and Tanglish. Validates result relevance, budget compliance, and OOS detection.
- **E2E AI Agent Tests** (`test_ai_e2e.js`): 12 test cases testing product search through the full AI agent pipeline. Results are counted (passed/partial/failed) with 5s gaps between tests.

### Previous Milestones
- WhatsApp Web Linked Device integration (QR-code, headless puppeteer, auto-reconnect)
- Message queue with concurrency 5 via `async` library
- Google Sheets lead logging (first-contact only)
- Dynamic language mirroring (English ↔ Tanglish)
- PDF invoice generation via PDFKit
- Cold lead follow-up scheduler (every 30 min, max 2 follow-ups)
- WooCommerce product cache + token-scored local search
- Bulk order escalation to owner (WhatsApp + Telegram)
- Triple LLM fallback chain (Groq → OpenAI → Gemini)
- Global rate-limit throttling (600ms gap)

### 🆕 Session Fixes (2026-07-10)
- **Fixed real duplicate-order bug**: the persistent retry queue never cleared an entry when the WhatsApp send failed (e.g. test/invalid sender IDs), so a stale entry replayed and created a new broken WooCommerce order on every server restart. Now always cleared unless the retry itself re-exhausts quota.
- **Fixed `confirm_order` accepting corrupted carts**: added validation that every cart item has a real name and price > 0 before placing a real order.
- **Fixed model defaulting to a canned greeting instead of answering**: when the LLM gave up on calling `search_products` (often after a Groq tool-call glitch) it would recite the FAQ greeting boilerplate verbatim regardless of the question asked — confirmed reproducible from old conversation logs. Added a guardrail that forces a retry, and a deterministic fallback that answers from real search results if the model repeats the leak.
- **Restored `tool_use_failed` retry**: Groq occasionally rejects its own malformed tool-call generation with a 400 — retrying the same key/turn fixes it; this handling had been accidentally dropped in an uncommitted change.
- **Deterministic Tanglish/English detection**: language is now detected once via keyword/script matching (not left to the LLM to guess every turn) and locked into the session; Tanglish sessions route to Gemini first (better code-mixed quality than Groq's Llama-3.3), English stays on Groq first.
- **Per-key rate-limit throttle + rotation**: the 5 Groq keys used to share one throttle timer (zero extra throughput from having 5 keys) and every request always tried key[0] first. Now each key throttles independently and requests round-robin across keys.
- **Per-key quota exhaustion tracking**: one Groq key hitting its daily quota used to blacklist all 5 keys for the whole reset window (confirmed live in logs — "Skipping groq[1]/[2]/[3]/[4]" right after key[0] exhausted). Now only the actually-exhausted key is benched.
- **Fixed same-customer message race**: the WhatsApp queue (flat concurrency-5 pool) could process two messages from the same customer in parallel, racing on the session read-modify-write and silently losing an update (e.g. "size M" then "qty 3" sent seconds apart). Replaced with per-sender chaining — same customer processed strictly in order, different customers still fully parallel.
- **Cleanup**: cancelled a junk ₹0 test order created by the retry-queue bug; removed ~78 fake test/debug customer records from `customers.json`, keeping the 4 genuine WhatsApp contacts.

### 🆕 Session Fixes (2026-07-11)
- **Fixed a second tool-call leak shape**: the guardrail above only caught the "recites the FAQ greeting" leak. Live testing surfaced a different failure — the model leaking raw/malformed tool-call JSON as plain text (e.g. `{"function":"search_products","query":"..."}`), in a shape the existing stripping regexes didn't recognize, and a third variant where stripping succeeded but left nothing (falling through to a generic "could you repeat that" non-answer). All three shapes now route through the same forced-retry → deterministic-fallback guardrail.
- **Fixed missing product links**: both deterministic fallback templates (the leak guardrail's, and `_buildNoLLMFallback`) showed name/price/sizes but never the product page permalink — a real conversion-cost bug since customers had no direct link to buy. Both now include `theaurax.in/product/...` links.
- **Fixed language locking in too early**: `session.language` was set on the very first message and never re-checked — a neutral opener like "hi" (no Tanglish signal) locked the whole conversation into English before a real Tanglish message ("messi jersey iruka bro") could ever change it. Confirmed live from a real customer conversation (RAKESH). Now re-checked every turn: switches to Tanglish the moment any real signal appears, never reverts back to English afterward.
- **Made fallback templates language-aware**: previously the deterministic/no-LLM fallback replies were English-only regardless of `session.language`. Both now produce a Tanglish variant when appropriate.
- **Gemini free-tier investigation — open, needs a decision**: confirmed via the Google AI Studio usage dashboard that Gemini's "limit: 0" errors are not a burst/overuse artifact (checked: 28-day usage chart showed one short burst then flat, but a fresh single test call still failed identically). Generated and tested a brand-new key from a **different Google account/project** — got the exact same `limit: 0` on every metric, including the daily one. This rules out "just get more free keys" as a fix; it looks like a systemic free-tier eligibility restriction, not per-account overuse. Two options on the table: (1) enable billing on a Google Cloud project — Gemini 2.0 Flash is cheap at this bot's volume, or (2) deprioritize Gemini and rely on Groq (already confirmed working fine for Tanglish via fallback, just without Gemini's slightly better code-mixing). **Decision deferred to next session.** `.env`'s `GEMINI_API_KEY` currently holds the new (also non-functional) key.

### 🆕 Planned / Future Ideas (discussed, not yet implemented)
Reducing LLM API calls further (current volume is cost/quota constrained):
1. Expand FAQ coverage (`faq.json`) so more common questions get answered instantly, zero LLM cost — no downside.
2. Stop embedding the full FAQ block in the system prompt when it's redundant (the FAQ matcher already handles those questions before the LLM sees them in idle state) — cuts token cost per call.
3. Deterministic order-confirmation bypass — match "yes"/"confirm"/"seri" in `CONFIRMING_ORDER` state without an LLM call.
4. Deterministic size+quantity parsing (e.g. "M 3") via regex before falling back to the LLM.
5. Template simple single-match product lookups instead of a second LLM "narration" call — saves a call but trades away some sales hype/personality in that reply; a deliberate tradeoff, not a free win.

On "training the model" from stored conversations (weekly/monthly): storing conversations in a database for periodic review is worth doing regardless. Actual fine-tuning of model weights is a heavier, riskier path — Groq (primary provider) doesn't offer fine-tuning for its hosted models at all; OpenAI/Gemini fine-tuning would need a carefully curated dataset (raw failure logs are the wrong training data as-is — they'd reinforce the same mistakes unless corrected into ideal examples first), real cost, and risk of making the model worse elsewhere from a small/narrow dataset. The practical equivalent that gets the same real benefit safely: periodically review real conversations for failures and patch the system prompt/FAQ/product aliases/guardrails based on what's found — this is literally how the greeting-leak bug and the Tanglish routing fix were discovered and fixed this session, from old conversation logs in `leads.json`.

**Database for this**: use MongoDB, not the flat JSON files — no new code needed, `db.js` already supports it via `MONGODB_URI` in `.env` (falls back to JSON files when unset). A free-tier MongoDB Atlas cluster is enough. Flat JSON files don't scale for searching/filtering hundreds of conversations later (e.g. "show me every chat that escalated" or "show me chats that never reached an order"); a real database makes that trivial.

**Making the review loop practical**: the "read old conversations for failures" step doesn't need to mean reading every single chat by hand. A small script can flag likely-problem conversations automatically — ones where the bot's fallback/error message appeared, ones where the customer repeated the same question 2-3 times (a sign of confusion), or ones that ended without reaching a completed order (possible drop-off). That narrows hundreds of chats down to a handful worth actually reading. Reading those flagged chats and deciding the fix (new FAQ entry, product alias, new rule) stays manual — there's no way around a human judgment call there, but it's a small, one-time edit each time, not model retraining.

### 🟡 Known Limitations
- **Groq, OpenAI quotas — may be exhausted** — API keys are valid but daily quota may be used up. The proactive quota-skipping logic avoids wasting time on exhausted providers.
- **WooCommerce website in maintenance mode** — order creation (`createOrder`) and product sync (`npm run sync`) unavailable until site is live.
- **Gemini key is rate-limited** — returns 429 when called too frequently. Per-provider throttling + 3-attempt retry loop handles this.
- **OpenRouter free models may be rate-limited** — `meta-llama/llama-3.3-70b-instruct:free` has rate limits. Configure a paid model via `OPENROUTER_MODEL` for better reliability.
- **Instagram DM not active** — Meta app review required before Instagram integration works.

---

## Key Decisions Made
1. **WhatsApp Web Override**: Bypassed Meta Cloud API to use a linked-device WhatsApp Web approach for faster testing without Meta app approvals.
2. **Dynamic Language Mirroring**: The bot acts as a local sales expert using Tanglish slang ("Bro", "Kandippa") to boost conversion rates. Language is detected deterministically in code (not left to the LLM's judgment each turn) and locked in for the conversation — see Session Fixes (2026-07-10).
3. **Model Upgrade**: Using `llama-3.3-70b-versatile` for complex multi-lingual tool logic.
4. **FAQ-First Architecture**: FAQs are answered pre-LLM to save tokens and eliminate leak risk.
5. **Quadruple Fallback Chain**: Groq → OpenAI → OpenRouter → Gemini ensures no single provider outage stops the bot.
6. **Persistent Retry Queue**: setTimeout + DB persistence ensures retries survive server restarts.
7. **Per-Provider Throttling**: Each provider has its own throttle timer tuned to its rate limits, avoiding unnecessary delays on faster providers.
8. **Proactive Quota Skipping**: Providers with recently exhausted quotas are skipped until their reset window passes, reducing latency.

---

## Instagram DM Integration — Setup Guide (added 2026-07-18)

How to connect the existing AI chatbot to Instagram DMs.

**Status:** The *sending* half is built (`src/services/instagram.js`) and config keys are
reserved. The inbound *webhook receiver* (in `src/index.js`) is **not yet built** — that is
the one real code gap.

### Key concept: Instagram is NOT like WhatsApp here
The WhatsApp bot uses `whatsapp-web.js` — an **unofficial**, QR-scan browser session.
Instagram has **no** safe equivalent. It **must** go through the **official Meta Graph API**
with a **public HTTPS webhook**. `localhost:3000` will not work — Meta needs a publicly
reachable URL.

### What already exists in the code
| Piece | Status | Location |
|-------|--------|----------|
| Instagram **send** service (Graph API `/me/messages`) | ✅ Built (MOCK mode without a token) | `src/services/instagram.js` |
| Config keys | ✅ Reserved | `src/config/config.js:71` |
| Inbound **webhook receiver** | ❌ Missing — must be added to `src/index.js` | — |

Config keys already present (`.env`):
```
INSTAGRAM_PAGE_ACCESS_TOKEN=      # Page Access Token from the Meta app
INSTAGRAM_VERIFY_TOKEN=           # defaults to theaurax_verify_token_2026
OWNER_INSTAGRAM_ID=               # optional
```

### What's missing (the code gap)
Two endpoints to add to `src/index.js`:
1. **`GET /webhook/instagram`** — verification handshake. Echoes `hub.challenge` when
   `hub.verify_token` matches `INSTAGRAM_VERIFY_TOKEN`.
2. **`POST /webhook/instagram`** — receives DMs, extracts sender IGSID + text, calls
   `aiService.answerQuery()`, replies via `instagramService.sendTextMessage()`.

### Meta / dashboard side (browser setup)
1. **Instagram account must be Professional** (Business or Creator) — convert in the IG app.
2. **Link the IG account to the business/Page** — Meta Business Suite → left nav →
   **Instagram accounts** → connect it, link to the "Rocky Testing" Facebook Page.
3. **In the Meta app** (developers.facebook.com):
   - Add the **Instagram** product (Instagram API / Messaging).
   - Under **Webhooks**: callback URL `https://<public-url>/webhook/instagram`, verify token
     `theaurax_verify_token_2026` (must match `.env`), **subscribe to the `messages` field**.
   - Generate a **Page Access Token** with `instagram_basic`, `instagram_manage_messages`,
     `pages_manage_metadata`, `pages_messaging`. Put it in `.env` as
     `INSTAGRAM_PAGE_ACCESS_TOKEN`.
   - **Subscribe the app to the Page.**
4. **Instagram app → Settings → Messages → Connected Tools → allow access to messages.**
5. **Testing vs. live:** Until **App Review** approves `instagram_manage_messages`, the bot
   can only DM accounts with a **role on the app** (admin/tester). **24-hour rule:** you can
   only reply within 24h of the user's last message (unless using approved message tags).

### Public URL requirement
- **Testing:** `ngrok http 3000` → use `https://<subdomain>.ngrok.../webhook/instagram`.
- **Production:** deploy to a host with a real domain + HTTPS.

### Recommended order of operations
1. Add the webhook route to `src/index.js` (the missing code piece).
2. Start ngrok → get the public HTTPS URL.
3. Wire the Meta app: webhook URL + verify token + subscribe `messages`.
4. Add the Page Access Token to `.env`.
5. DM the IG account from a tester account → confirm the AI replies.

---

## How To Use This File
In any new Claude Code session, say:
> "Read my project context at C:\Users\Hp\theaurax_context.md and continue the Theaurax AI Sales Assistant project"

Claude will load this file and continue from exactly where we left off.
After each session, ask Claude to update this file with new decisions, progress, and next steps.

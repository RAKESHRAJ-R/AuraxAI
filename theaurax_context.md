# Theaurax AI Sales Assistant — Project Context

## Last Updated
2026-07-07

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
   Classify via LLM (Groq → OpenAI → Gemini fallback chain):
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
| AI Engine | Groq (LLaMA 3.3-70B) → OpenAI (GPT-4o-mini) → Gemini (2.0 Flash) | Triple fallback chain |
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
- **Triple LLM fallback chain**: Groq → OpenAI → Gemini
- **Pre-AI FAQ matcher**: Zero LLM calls for common questions
- **Rate-limit throttling**: 600ms min gap between API calls
- **Two-pass tool call stripping**: Eliminates leaked tool syntax from responses
- **Persistent retry queue**: Survives server restarts (DB-backed)
- **Monitoring endpoint**: GET /api/retry-stats

---

## Current Status

### ✅ Completed & Working
- **Pre-AI FAQ Matcher** (`ai.js`): FAQ queries (COD, shipping, sizing, returns, etc.) are answered **instantly without any LLM call** — zero token cost, zero leak risk. Gated on session state `IDLE` so it won't intercept order messages.
- **Two-Pass Tool Call Stripping** (`ai.js`): When Groq returns leaked text alongside a tool call, the text is discarded immediately — only the tool call is processed.
- **Rate-Limit Throttling** (`ai.js`): Global 600ms minimum gap between all LLM API calls (static `lastApiCallTime` + `callWithThrottle()`).
- **Multi-LLM Fallback Chain** (`ai.js`): Groq (LLaMA 3.3-70B) → OpenAI (GPT-4o-mini) → Gemini (2.0 Flash). When one provider fails, the next is tried automatically.
- **Gemini Integration** (`ai.js`): Full message format conversion (OpenAI ↔ Gemini) via `_buildGeminiConversation()`. Supports all roles: system, user, assistant with tool_calls, tool with functionResponse. Includes 2-attempt retry loop.
- **Persistent Retry Queue** (`db.js` + `ai.js` + `index.js`): Quota-exhausted queries are saved to DB (MongoDB or JSON) and retried automatically. Survives server restarts. Runs 15s after startup + every 60s.
- **Retry Stats Endpoint** (`index.js`): `GET /api/retry-stats` shows pending retries, due count, provider config status, and active provider.
- **Active Provider Tracking** (`ai.js`): `aiService.activeProvider` reports which LLM is currently handling requests.

### Previous Milestones
- WhatsApp Web Linked Device integration (QR-code, headless puppeteer, auto-reconnect)
- Message queue with concurrency 5 via `async` library
- Google Sheets lead logging (first-contact only)
- Dynamic language mirroring (English ↔ Tanglish)
- PDF invoice generation via PDFKit
- Cold lead follow-up scheduler (every 30 min, max 2 follow-ups)
- WooCommerce product cache + token-scored local search
- Bulk order escalation to owner (WhatsApp + Telegram)

### 🟡 Known Limitations
- **Groq & OpenAI quotas currently exhausted** — API keys are valid but daily quota used up. Refill or wait for reset.
- **WooCommerce website in maintenance mode** — order creation (`createOrder`) and product sync (`npm run sync`) unavailable until site is live.
- **Gemini key is valid but rate-limited** — returns 429 when called too frequently. The 600ms throttle + 2-attempt retry loop handles this. Gemini is the **active fallback** when Groq/OpenAI are exhausted.
- **Instagram DM not active** — Meta app review required before Instagram integration works.

---

## Key Decisions Made
1. **WhatsApp Web Override**: Bypassed Meta Cloud API to use a linked-device WhatsApp Web approach for faster testing without Meta app approvals.
2. **Dynamic Language Mirroring**: The bot acts as a local sales expert using Tanglish slang ("Bro", "Kandippa") to boost conversion rates.
3. **Model Upgrade**: Using `llama-3.3-70b-versatile` for complex multi-lingual tool logic.
4. **FAQ-First Architecture**: FAQs are answered pre-LLM to save tokens and eliminate leak risk.
5. **Triple Fallback Chain**: Groq → OpenAI → Gemini ensures no single provider outage stops the bot.
6. **Persistent Retry Queue**: setTimeout + DB persistence ensures retries survive server restarts.

---

## How To Use This File
In any new Claude Code session, say:
> "Read my project context at C:\Users\Hp\theaurax_context.md and continue the Theaurax AI Sales Assistant project"

Claude will load this file and continue from exactly where we left off.
After each session, ask Claude to update this file with new decisions, progress, and next steps.

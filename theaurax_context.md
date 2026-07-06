# Theaurax AI Sales Assistant — Project Context

## Last Updated
2026-06-14

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
   Webhook receives instantly
       ↓
   Classify:
   - Simple query (price/size/COD/delivery) → Fetch from FAQ/website → Reply directly (NO AI)
   - General/browsing (what jerseys?) → AI suggests products from WooCommerce catalog
   - Bulk order (50+ pieces, wholesale) → Alert owner on WhatsApp instantly
   - Ready to buy (order intent) → Send product link + guide to TheAurax.in checkout
```

---

## Tech Stack (Decided)
| Component | Tool | Notes |
|---|---|---|
| WhatsApp API | WATI.io | Fastest setup, no Meta approval wait |
| Instagram DM | Meta Graph API | Needs Meta app review (2-4 weeks) — Phase 2 |
| Backend | Node.js on VPS | Hetzner CX22 (~₹700/month) |
| Database | MongoDB | Store chats, leads, orders |
| AI Engine | Claude API (claude-sonnet-4-6) or OpenAI GPT | For general/product queries |
| Product Catalog | WooCommerce REST API | Pull products, prices, stock, images |
| Invoice | PDF generation (pdfkit) | Auto-send via WhatsApp |
| Server | Hetzner or DigitalOcean VPS | 24/7 uptime |

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

## Pre-Requirements Checklist (Get From Client)

### From TheAurax.in
- [ ] WooCommerce Consumer Key + Consumer Secret
- [ ] WordPress admin access
- [ ] All products listed with prices, sizes, stock, images in WooCommerce

### From Their Accounts
- [ ] Dedicated WhatsApp Business number (NOT personal number)
- [ ] Facebook Business Manager account (verified)
- [ ] Instagram Business Account linked to Facebook Page
- [ ] Meta Developer Account access

### Business Information
- [ ] FAQ list (common Q&A: price range, sizes, COD, delivery time, return policy)
- [ ] Shipping charges (flat rate or state-wise)
- [ ] Delivery timeline (local vs outstation)
- [ ] COD availability + minimum order value
- [ ] Courier partner (Shiprocket / Delhivery / manual?)
- [ ] Owner's WhatsApp number (for bulk order alerts)
- [ ] Brand logo + colors (for invoices)
- [ ] Bulk order threshold (at what quantity it becomes "bulk"?)

---

## Build Phases

### Phase 1 — WhatsApp Bot Core (Week 1-2)
- Set up WATI.io account with client's WhatsApp number
- Set up VPS (Hetzner CX22)
- Build Node.js webhook handler
- Build message classifier (keyword-based)
- FAQ engine with predefined answers
- WooCommerce product fetch + cache
- Bulk alert to owner

### Phase 2 — Order Flow + Invoice (Week 3)
- Conversation flow to collect order details (product, size, qty, address)
- Auto PDF invoice generation
- Send invoice via WhatsApp

### Phase 3 — Follow-up + Lead Tracking (Week 4)
- MongoDB lead storage
- Scheduled follow-up if customer goes cold
- Thank-you + feedback after delivery

### Phase 4 — Instagram DM (Week 5-6)
- Meta app review submission (start early)
- Same classifier logic, different API
- Handle 24h window restriction with templates

---

## Current Status
- WhatsApp Web Linked Device integration implemented, with QR-code generation and headless puppeteer.
- **Message Queue / Concurrency Management** implemented using `async` library to handle massive traffic spikes and protect the Groq API from rate limits.
- **Google Sheets Integration** completed. The bot automatically extracts the customer's real phone number (bypassing the internal Meta @lid ID) and logs first-time inquiries to the Google Sheet.
- **Memory Token Optimization**: Chat history memory sliced from 15 down to 10 messages to dramatically reduce token consumption while maintaining enough context for checkout.
- AI system prompt completely revamped with **Dynamic Language Mirroring**. It will aggressively hype products in natural Tanglish if the user speaks Tanglish, but will switch to professional English if the user speaks English.
- AI model upgraded from `llama-3.1-8b-instant` to `llama-3.3-70b-versatile` for enhanced tool calling stability.
- **NEXT STEP**: Implement Few-Shot Prompting inside the `ai.js` system instructions to completely eliminate JSON tool-calling syntax errors (e.g., `<function>` leaks) that occur when Groq's parser clashes with the Tanglish persona.

---

## Key Decisions Made
1. **WhatsApp Web Override**: We temporarily bypassed Meta Cloud API to use a linked-device WhatsApp Web approach for faster testing without Meta app approvals.
2. **Dynamic Language Mirroring**: The bot is no longer restricted to English. It acts as a local sales expert using common Tanglish slang ("Bro", "Kandippa") to boost conversion rates.
3. **Keep Groq (No Gemini Yet)**: We decided to stick with the Groq API and optimize memory rather than switching back to Gemini, due to Groq's speed and strict adherence to the OpenAI tool calling format.
4. **Model Upgrade**: Using `llama-3.3-70b-versatile` to handle complex multi-lingual tool logic, as the 8B model was too small and routinely leaked `<function>` tags into the WhatsApp chat.

---

## How To Use This File
In any new Claude Code session, say:
> "Read my project context at C:\Users\Hp\theaurax_context.md and continue the Theaurax AI Sales Assistant project"

Claude will load this file and continue from exactly where we left off.
After each session, ask Claude to update this file with new decisions, progress, and next steps.

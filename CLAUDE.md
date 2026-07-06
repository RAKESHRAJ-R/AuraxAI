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
```

## Environment Setup

Create a `.env` file in the root with:

```
GROQ_API_KEY=            # Required: Groq API key for LLaMA inference
GROQ_MODEL=              # Optional: defaults to llama-3.3-70b-versatile (smaller models tested unreliable at real tool-calling for cart/order flow)
WOOCOMMERCE_URL=         # Required: https://theaurax.in
WOOCOMMERCE_CONSUMER_KEY=
WOOCOMMERCE_CONSUMER_SECRET=
WHATSAPP_WEB_ENABLED=true
OWNER_WHATSAPP_NUMBER=   # Owner's WhatsApp for escalation alerts
BULK_ORDER_THRESHOLD=20  # Qty threshold for bulk order escalation
TELEGRAM_BOT_TOKEN=      # Optional: owner alerts via Telegram
TELEGRAM_CHAT_ID=
GOOGLE_SHEETS_ID=        # Optional: for lead logging
MONGODB_URI=             # Optional: MongoDB for persistent sessions (JSON fallback used if absent)
BASE_URL=http://localhost:3000
ALLOWED_TEST_NUMBERS=    # Comma-separated numbers for safe-mode (only these get replies)
PORT=3000
```

Google Sheets requires a `credentials.json` service account file in the project root.

## Architecture

This is a WhatsApp AI sales bot for **Theaurax.in** (football jerseys). It runs as an Express server and uses `whatsapp-web.js` to connect to WhatsApp via a headless Puppeteer browser session.

### Request Flow

1. A WhatsApp message arrives → `whatsapp-web-bot.js` queues it (concurrency 5 via `async.queue`)
2. The queue handler calls `aiService.answerQuery()`
3. `ai.js` manages a multi-turn agentic loop (up to 5 iterations) with Groq's LLaMA 70B model using the OpenAI-compatible SDK
4. The AI calls tools (`search_products`, `update_cart`, `set_shipping_address`, `confirm_order`, `escalate_to_human`, `get_faqs`) which are executed server-side
5. On order confirmation, `invoice.js` generates a branded PDF proforma invoice served at `/invoices/`
6. Bulk orders (≥ threshold qty) trigger `sendEscalationAlert()` which notifies the owner via WhatsApp + Telegram
7. First-contact leads are logged to Google Sheets via `sheets.js`
8. Session state and leads are persisted to MongoDB or JSON files in `src/data/`

### Key Services

| File | Purpose |
|------|---------|
| `src/services/ai.js` | Core AI agent — system prompt, tool definitions, agentic loop |
| `src/services/whatsapp-web-bot.js` | WhatsApp Web client lifecycle and message handling |
| `src/services/woocommerce.js` | WooCommerce product sync and local token-scored search |
| `src/services/db.js` | Session + lead persistence (MongoDB or JSON files) |
| `src/services/invoice.js` | PDFKit-based proforma invoice generation |
| `src/services/sheets.js` | Google Sheets lead logging (first-contact only) |
| `src/services/telegram.js` | Telegram owner alert notifications |
| `src/services/faq.js` | FAQ search from `src/data/faq.json` |
| `src/config/config.js` | Centralised config with env-var fallbacks |

### Session State Machine

Sessions progress through: `IDLE → COLLECTING_ADDRESS → CONFIRMING_ORDER → IDLE`

On `confirm_order`, a real WooCommerce order is created via REST API (`woocommerce.createOrder()`). The customer receives a direct payment URL (`/checkout/order-pay/{id}/?pay_for_order=true&key={key}`) to complete checkout. If WooCommerce order creation fails, the bot falls back to a PDF invoice.

The cart holds only one product at a time (replaced on each `update_cart` call).

### Customer Registry

Every customer interaction upserts a record in `src/data/customers.json` (or MongoDB `customers` collection). Use `dbService.getAllCustomers()` to retrieve all contacts for product launch campaigns or bulk messaging.

### Cold Lead Follow-Up

`src/services/followup.js` runs a check every 30 minutes. Any active lead inactive for 3+ hours (up to 2 times) gets a personalized re-engagement message via WhatsApp. Cart contents are referenced in the message if available.

### Product Cache

`src/data/products_cache.json` is a local snapshot of WooCommerce products. Run `npm run sync` to refresh it. The search uses token-matching with relevance scoring — no embeddings or vector DB.

### WhatsApp Connection

On first run, visit `http://localhost:3000/whatsapp-link.html` to scan the QR code. Auth is persisted in `.wwebjs_auth/` (Puppeteer LocalAuth). The bot auto-reconnects on disconnect with a 10-second delay.

### Safe Mode

If `ALLOWED_TEST_NUMBERS` is set, the bot only responds to those phone numbers — useful for staging.

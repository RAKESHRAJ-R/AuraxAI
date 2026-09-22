# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

Restructured into a monorepo on 2026-08-02 so the admin console could be deployed to Vercel
independently of the bot:

```
TheAurax/
├── package.json          Thin orchestrator — pass-through scripts only, no dependencies
├── apps/
│   ├── bot/              The WhatsApp bot + Express API (everything that was at the root)
│   │   ├── src/          ← ALL `src/...` paths elsewhere in this file are relative to here
│   │   ├── public/       Served by express.static; invoice PDFs land in public/invoices
│   │   ├── .env          Bot config. Loaded from apps/bot/.env, NOT the repo root
│   │   └── package.json  The real dependency manifest — `npm ci` runs HERE, not at the root
│   └── admin/            React admin console (Vite SPA)
│       ├── src/
│       ├── vercel.json   Vercel build + SPA rewrite + security headers
│       ├── dist/         Vercel build (base '/')       — gitignored, Vercel builds it
│       └── dist-express/ Self-hosted build (base '/admin/') — COMMITTED, Express serves it
├── scripts/              Ops scripts (Mongo backup)
└── CLAUDE.md, DEPLOY.md, theaurax_context.md, reports/
```

**Two things bite if forgotten:**
- The bot resolves `public/`, `.models/` and `.wwebjs_auth/` from the **process CWD**, so it
  must be started from `apps/bot/` (systemd `WorkingDirectory`, or `npm run bot` from the root).
- `apps/admin` is not an npm workspace — it installs separately. Keeping it out of the root
  means `npm ci --omit=dev` on the VPS never pulls React/Vite onto the server.

## Commands

```bash
# ── from the repo root ──
npm run bot            # Start the server (runs apps/bot's `start` with the right CWD)
npm run install:all    # Install both apps' dependencies
npm run dev-admin      # Vite dev server on :5174, proxies /api to the bot on :3000
npm run build-admin    # Build apps/admin/dist-express (the /admin build Express serves).
                       # NOT the Vercel build — Vercel runs `npm run build` itself.

# ── from apps/bot ──
npm start              # Start the server
npm run sync           # Sync products from WooCommerce API to local cache
npm run test-agent     # AI agent tests (single-turn + multi-turn sales funnel simulation)
npm run test-whatsapp  # WhatsApp test script
npm run test-embeddings # Embeddings/retrieval regression suite (28 checks)
npm run review         # Semi-automated conversation review — flags likely-problem
                       # conversations (fallback/error reply, repeated question,
                       # abandoned mid-purchase)
npm run migrate-mongo  # One-time migrate local JSON data → MongoDB (needs MONGODB_URI)
npm run check-woo      # WooCommerce REST connectivity — tests BOTH credentials against
                       # products AND orders and names the exact failure. Run this before
                       # `npm run sync`, after any credential change, and on the VPS after
                       # a deploy. Exit code 1 when nothing can both read and order.
npm run test-admin-auth # Admin accounts/roles/permissions suite (temp dir, never live data)
npm run test-followup  # Cold-lead follow-up guards (no-loop, age, per-run caps) — stubbed, sends nothing
npm run test-search    # Product-search regression from the 2026-09-20 tester reviews (60 checks):
                       # season/version constraints, honest partial + no-match replies,
                       # context carried across turns, and the real agent reply path
npm run test-order-flow # Order confirmation integrity (43 checks) — a failed order must never
                       # be reported as confirmed. Stubbed: places no orders, sends nothing
npm run test-tanglish  # Tanglish quality, machine-output leakage and guided browse (182
                       # checks) — from the 2026-09-21 client report. Asserts that no
                       # tool-call/JSON/escape fragment and no broken markdown can reach a
                       # customer on ANY reply path, that good replies and the store's own
                       # FAQ pass through untouched, that the invented Tamil seen in
                       # production is detected, and that "I don't know what to buy" reaches
                       # a cart in three turns. Stubbed LLM — no spend, nothing sent.
npm run admin-user -- --email x@y.z --password "..."   # Create/recover an Owner login

node src/test_agent.js "Do you have Barcelona jerseys?"   # single ad-hoc query

# ── from apps/admin ──
npm run dev            # Vite dev server
npm run build          # Vercel build   → dist/         (base '/')
npm run build:express  # Self-hosted    → dist-express/ (base '/admin/')
```

## Environment Setup

Create `apps/bot/.env` with:

```
GROQ_API_KEY=              # Required: Groq API key for LLaMA inference
GROQ_MODEL=                # Optional: defaults to llama-3.3-70b-versatile
OPENAI_API_KEY=            # Optional: OpenAI fallback (GPT-4o-mini)
GEMINI_API_KEY=            # Optional: Gemini fallback (Gemini 2.0 Flash)
FIREWORKS_API_KEY=         # Optional: Fireworks paid fallback (comma-sep for multiple keys)
FIREWORKS_MODEL=           # Optional: defaults to accounts/fireworks/models/deepseek-v4-pro-0813
SARVAM_API_KEY=            # Optional: Sarvam (Indic-native) paid provider — Tanglish-first (comma-sep for multiple keys)
SARVAM_MODEL=              # Optional: defaults to sarvam-105b (sarvam-30b is RETIRED — 400s)
WOOCOMMERCE_URL=           # Required: https://theaurax.in
WOOCOMMERCE_CONSUMER_KEY=
WOOCOMMERCE_CONSUMER_SECRET=
WOOCOMMERCE_APP_USER=      # WP username for an Application Password — PREFERRED over the
WOOCOMMERCE_APP_PASSWORD=  # consumer key when set (see "WooCommerce REST blocked" below)
WHATSAPP_WEB_ENABLED=true
OWNER_WHATSAPP_NUMBER=     # Owner's WhatsApp for escalation alerts
BULK_ORDER_THRESHOLD=10    # Qty threshold for bulk order escalation (default)
GOOGLE_SHEETS_ID=          # Optional: for lead logging
MONGODB_URI=               # Optional: MongoDB for persistent sessions (JSON fallback used if absent)
CATCHUP_ENABLED=true       # Missed-message catch-up (default on). false = missed customers NOT answered
CATCHUP_FRESH_HOURS=12     # Answered immediately on reconnect; older goes to the slow drip
CATCHUP_MAX_AGE_DAYS=2     # Never answer a message older than this. 0 = no age limit
CATCHUP_DRAIN_PER_HOUR=120 # Backlog drip rate — raising this raises ban risk
CATCHUP_ALERT_OWNER=true   # WhatsApp summary to the owner per sweep
CATCHUP_DRY_RUN=false      # true = sweep + report only, message nobody (validate before going live)
BASE_URL=http://localhost:3000
ALLOWED_TEST_NUMBERS=      # Comma-separated numbers for safe-mode (only these get replies)
ADMIN_OWNER_EMAIL=         # Creates the FIRST Owner console account (only when no accounts exist)
ADMIN_OWNER_PASSWORD=      # Its password; falls back to the legacy AURAX_TEAM_PASSWORD
ADMIN_SESSION_TTL_HOURS=168 # Console sign-in lifetime
BREVO_API_KEY=             # Optional: emails staff their console login (Brevo transactional API)
MAIL_FROM_EMAIL=           # Verified Brevo sender, e.g. no-reply@theaurax.in
MAIL_FROM_NAME=Aurax Admin
ADMIN_CONSOLE_URL=         # Sign-in link in those emails (the Vercel URL); defaults to BASE_URL/admin
ADMIN_ALLOWED_ORIGINS=     # Required for the Vercel-hosted admin console: comma-separated
                           # origins allowed to call the API cross-origin. `*.`-prefixed
                           # entries are suffix matches (e.g. *.vercel.app for previews).
PORT=3000
```

Google Sheets requires a `credentials.json` service account file in `apps/bot/`.

`apps/admin` has its own build-time env (`apps/admin/.env.example`) — `VITE_API_BASE_URL`
and `VITE_DEV_API_PROXY`. Vite inlines `VITE_*` into the public bundle, so never put a
secret there.

## Architecture

This is a WhatsApp AI sales bot for **Theaurax.in** (football jerseys). It runs as an Express server and uses `whatsapp-web.js` to connect to WhatsApp via a headless Puppeteer browser session.

### Request Flow

1. A WhatsApp message arrives → `whatsapp-web-bot.js` queues it (concurrency 5 via `async.queue`)
2. The queue handler calls `aiService.answerQuery()`
3. **FAQ Matcher** — If session is IDLE, common FAQ queries are answered instantly from `faq.json` with ZERO LLM calls
4. If not an FAQ → `ai.js` manages a multi-turn agentic loop (up to 5 iterations) with **triple fallback chain**: Groq → OpenAI → Gemini
5. The AI calls tools (`search_products`, `update_cart`, `set_shipping_address`, `confirm_order`, `escalate_to_human`) which are executed server-side
6. On order confirmation, `invoice.js` generates a branded PDF proforma invoice served at `/invoices/`
7. Bulk orders (≥ threshold qty) trigger `sendEscalationAlert()` which notifies the owner via WhatsApp
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
| `src/services/faq.js` | FAQ search from `src/data/faq.json` |
| `src/services/followup.js` | Cold-lead re-engagement (every 30 min, max 2 follow-ups) |
| `src/config/config.js` | Centralised config with env-var fallbacks |
| `src/review_conversations.js` | Semi-automated review — flags conversations with fallback/error replies, repeated customer questions, or an abandoned mid-purchase cart for human review. Run via `npm run review`. |

### LLM Fallback Chain

```
English sessions:
Fireworks (deepseek-v4-pro-0813) → Primary (Groq was demoted 2026-07-27: tool_use_failed on this prompt)
  ↓ quota or error
Sarvam (sarvam-105b)           → Second
  ↓ quota or error
Groq (LLaMA 3.3-70B)           → Free backstop
  ↓ quota or error
OpenAI → OpenRouter → Gemini   → Further fallbacks
  ↓ all fail
Friendly error message + persistent retry scheduling

Tanglish sessions:
Sarvam (sarvam-105b)           → Tried FIRST — Indic-native, purpose-trained on romanized/code-mixed Tamil
  ↓ quota or error
Fireworks (deepseek-v4-pro-0813) → Paid backup (also strong at code-mixing)
  ↓ quota or error
Groq (LLaMA 3.3-70B)           → Fast free backstop, then OpenAI → OpenRouter → Gemini
```

**Sarvam provider (added 2026-07-20):** Indic-specialised paid provider (Sarvam AI, India),
OpenAI-compatible (`baseURL: https://api.sarvam.ai/v1`, `Authorization: Bearer` — wired exactly
like Fireworks). Sarvam's models are purpose-trained on native-script, romanized AND code-mixed
Indian-language text (Tamil included), so this takes the **Tanglish-first** slot ahead of
Fireworks — the specific weakness Llama-3.3 has. Full OpenAI-style tool calling confirmed live
in the agentic loop. Gated behind `SARVAM_API_KEY` — absent = provider simply isn't loaded,
chain degrades cleanly to Fireworks/Groq. Chosen per the 2026-07-15 provider research report
(`reports/LLM_Provider_Research_2026-07-15.pdf`), which recommended Sarvam over
Fireworks/Cerebras/NVIDIA-NIM for the Tanglish requirement.

⚠️ **Migrated sarvam-30b → sarvam-105b (2026-08-04) — forced, not optional.** Sarvam deprecated
`sarvam-30b` in June 2026 and it is now **gone from the API**: `GET /v1/models` returns
`sarvam-105b` only, and a completion with `model: 'sarvam-30b'` returns **HTTP 400**. Every
Tanglish message was therefore failing its first provider and silently falling through to
Fireworks. `sarvam-105b` (128K ctx) is the vendor's documented migration target and is now the
default in `config.js`; `sarvam-m` and the `-16k`/`-32k` variants are retired too. There is no
smaller/cheaper Sarvam chat model any more — **105b is the entire chat lineup.**

**Sarvam models are reasoning models and `/no_think` still matters.** The original `sarvam-30b`
spent its ENTIRE `max_tokens` budget on internal chain-of-thought (returned in a separate
`reasoning_content` field), leaving visible `content` null at `max_tokens` 800 AND 1500. `105b`
no longer truncates, but the tag is still clearly honoured and still worth keeping — measured
2026-08-04 against this bot's real prompt (12.5k chars) + a 6-product tool result:

| | completion tokens | reasoning | latency |
|---|---|---|---|
| with `/no_think` | 254 | 315 chars | 3.7s |
| without | 455 | 1061 chars | 6.3s |
| without, `max_tokens` 1500 | 1072 | 3119 chars | 12.7s |

Same answer quality either way, so the tag is ~45% fewer output tokens (the expensive kind) and
~2x faster. `ai.js` appends it to the system message for Sarvam only; `max_tokens` stays 800.

**Cost (verified 2026-08-04):** ₹4 / 1M input, **₹2.5 / 1M cached input**, ₹16 / 1M output —
105b is the only model, so this is the whole price list. A real measured Tanglish agent call
(`in=5416 cached=4480 out=104`) costs **₹0.017**. Prompt caching is doing real work: **83% of
input was billed at the cached rate**, which is what the 2026-07-20 cache-friendly prompt
ordering was for — keep dynamic session state at the END of the system prompt. ~90% of the
per-call cost is INPUT, so token-reduction work should target the system prompt + tool schema,
not the reply length. New accounts get ₹100 in free credits (~6,000 calls).

**Two keys are configured** (comma-separated in `SARVAM_API_KEY`) and round-robin through the
existing per-key rotation and per-key quota tracking.

**Fireworks provider (added 2026-07-17):** Client-supplied paid key, OpenAI-compatible
(`baseURL: https://api.fireworks.ai/inference/v1`), wired exactly like OpenRouter. Uses
`deepseek-v4-pro-0813` (see migration note below) — a reasoning model that returns the final answer cleanly in `content`
(no `reasoning_format` flag needed) but needs headroom, so `max_tokens` is 1500 for
Fireworks vs 800 for non-reasoning providers. Verified live: tool-calling works in the full
agentic loop, Tanglish quality clearly beats Llama-3.3, ~₹0.01–0.02/reply. Fireworks takes
the Tanglish-first slot that dead Gemini (`limit:0`) used to hold. Gated behind
`FIREWORKS_API_KEY` — absent = provider simply isn't loaded, no behavior change. A standalone
smoke test lives at `test_fireworks.js` (probes auth, available models, tool-calling, Tanglish).

⚠️ **Migrated deepseek-v4-pro → deepseek-v4-pro-0813 (2026-09-17) — forced, same story as
Sarvam-30b.** Fireworks deprecated the un-dated preview `deepseek-v4-pro` on **2026-08-27**
(model record: `deprecationDate 2026-08-27`, `supportsServerless: false`). It **still appears in
`GET /v1/models`**, which is what makes it easy to miss, but every completion returns
`404 Model not found, inaccessible, and/or not deployed`. For ~3 weeks every English message
failed its primary provider and fell through to Sarvam (production log 2026-09-16:
`fireworks failed, trying next... 404` on every call). `-0813` is the official release that
superseded it; verified against this bot's real system prompt + tool schema (English and
Tanglish both emit `search_products` in ~2-3s) and on standalone Tanglish replies. The key itself
was fine — `gpt-oss-120b` answered on it. **If Fireworks 404s again, check the model's
`deprecationDate` at `GET https://api.fireworks.ai/v1/accounts/fireworks/models/<id>` first.**
Also check the server `.env` for a `FIREWORKS_MODEL` override, which beats the code default.

### Session State Machine

Sessions progress through: `IDLE → COLLECTING_ADDRESS → CONFIRMING_ORDER → IDLE`

On `confirm_order`, a real WooCommerce order is created via REST API (`woocommerce.createOrder()`). The customer receives a direct payment URL (`/checkout/order-pay/{id}/?pay_for_order=true&key={key}`) to complete checkout. If WooCommerce order creation fails, the bot falls back to a PDF invoice.

The cart holds only one product at a time (replaced on each `update_cart` call).

### Deterministic Fast Paths (Zero LLM Calls)

Seven of the highest-frequency conversational turns are handled entirely in code — no LLM call, no rate-limit exposure, no hallucination risk:

1. **FAQ matching** (`faq.js` + pre-check in `ai.js`) — common questions (COD, shipping, sizing, returns, customization, bulk, tracking, cancellation, kids sizes, jersey care, international shipping) answered instantly from `faq.json`. Only runs when session is `IDLE` with an empty cart.

   **Bilingual since 2026-08-04.** The FAQ was English-only in both directions, which quietly
   cancelled this whole optimisation for Tanglish customers: keywords were `hi/hello`,
   `delivery time`, `how long` — so `"Vanakkam bro"` and `"Delivery ethana naal aagum?"` (the two
   most common Tanglish turns) missed every entry and paid for a full LLM call. Measured on a
   7-turn Tanglish conversation: 6 LLM calls where 5 were needed. Each entry now carries Tanglish
   keywords **and** an `answerTanglish` variant, picked by `faqService.answerFor(faq,
   session.language)` — adding keywords alone would have replied to a Tanglish customer in
   English, contradicting the locked `session.language`.

   ⚠️ **Greeting entries are `exactOnly`.** They match only when the message, minus filler
   (`bro`, `ji`, `anna`, `sir`, `there`…) and emoji, IS the greeting. Tanglish customers greet
   and ask in one breath — `"Vanakkam bro, Barcelona jersey irukka?"` — and since Greetings sits
   first in `faq.json`, an unguarded keyword would have returned a canned hello instead of a
   product search. This also closes the same hole on the English side (`"hi do you have real
   madrid jerseys"` used to match Greetings).
2. **Order-state turn** (`aiService._handleOrderStateTurn()` + `src/services/orderState.js`) — replaced the old `parseSizeQtyReply`/`parseProductSelectionOnly` regexes on 2026-09-22. Product pick, size, quantity, shipping details, "already sent", payment questions and "change product" are read from the customer's words *against the current state* and applied in code. See "Order State Layer" below. Intent tags: `deterministic_selection`, `deterministic_cart`, `state_*`.

   **`"<product no> <size> <qty>"` in one message** (`"2 M 5"`, `"3 size L 2"`) is handled by a
   dedicated branch, because it's the most natural answer to the bot's own *"Which one — 1, 2
   or 3? What size and how many?"* and it used to parse **wrong twice**: bare digits only
   counted as an ordinal next to a word like `"option"`, so the leading number was ignored and
   the product defaulted to #1 — and then the quantity regex grabbed that same leading digit
   before reaching the real quantity. `"2 M 5"` became *product #1, qty 2*. Two numbers either
   side of a size token is unambiguous (first = product, last = qty). If the product number or
   size doesn't exist it returns `null` rather than falling through to guess a different
   product.
3. **Order confirmation** (`aiService._confirmOrderNow()`) — a message that IS ENTIRELY a confirmation word/phrase (`"yes"`, `"confirm"`, `"seri"`, `"ok"`, etc. — anchored full-string match, not substring) during `CONFIRMING_ORDER` state creates the order directly. `"yes but change the address"` still goes to the LLM since it isn't purely a confirmation. Intent tag: `deterministic_confirm`.

4. **"Which teams do you have?"** (`woocommerceService.asksWhichTeams()` + `aiService.teamListReply()`) — answered from the in-stock product cache. Added 2026-09-22; see "Two questions the agent had no answer for". Intent tag: `deterministic_teams`.
5. **"I can't understand you"** (`purila` / `puriyala` / "what are you saying") — apologises once and repeats the offer in mostly plain English with the real team list. Intent tag: `deterministic_clarify`. Handled in code precisely because the recovery must not be generated by the model whose language just failed.
6. **"What do you even sell?"** (`asksWhatWeSell()` + `browseMenuReply()`) — the kinds of product we stock, numbered, for a customer who cannot name a team because they have never seen the range. Intent tag: `deterministic_browse`.
7. **Picking a kind off that menu** (`matchGroupChoice()` + `bestSellersReply()`) — that group's real best sellers, which then feed the size/quantity path above. Intent tag: `deterministic_browse_pick`. See "Guided browse".

A further optimization saves an LLM call without skipping it entirely: when `search_products` returns exactly one confident match, the reply is templated directly (randomized hype opener + product details) instead of feeding the result back for a second "narration" LLM call. Multiple matches still get narrated normally so the model can help the customer choose.

Together these cut LLM calls roughly in half on a typical size→address→confirm purchase flow, which matters because free-tier API quotas (Groq/Gemini) are shared across every concurrent customer — every call avoided is capacity freed up for everyone else.

### Order State Layer (added 2026-09-22)

Fixes a real chat where the customer picked the Messi 2009 shirt and the bot carted the Guardiola one at qty 2, asked for an address they had already sent, then showed the team list again ("Idhellaam ippo stock la iruku bro … Enna team venum?").

**Root causes that were fixed:**
- **Wrong product and wrong qty:** `parseSizeQtyReply` defaulted an unidentified product to **#1** and read the leading "2" of `"2 and one quantity and m size"` as the qty. It also had no word numbers, so "one quantity" was ignored.
- **LLM could overwrite the cart:** after the cart was filled, every message went to the LLM. `update_cart` took whatever product, size and qty the model sent.
- **Address asked again:** only 4 history messages were kept, and the address was stored only when the LLM called `set_shipping_address`. Details from earlier turns scrolled out of view.
- **Back to team selection:** the `search_products` "broad" branch, the unstocked-team fallback and the no-LLM fallback all ignored an order in progress.
- **Concurrent writes:** the quota-retry timer, the persistent retry queue and catch-up all called `answerQuery` outside the per-sender WhatsApp chain. A stale retry could also replay an old message against newer state.

**The fix:**
- **Structured fields** (the source of truth): `selectedProduct`, `pendingSize`/`pendingQty`, `cart`, `addressDraft`, `customerProfile` (kept across orders), `productListPending`, `pendingClarify`, `lastOrder`. `orderState.computeStep()` derives the step: DISCOVERY → PRODUCT_SELECTION → SIZE/QUANTITY_SELECTION → ADDRESS_COLLECTION → CART_REVIEW → PAYMENT_PENDING. `session.state` keeps its old values and adds `COLLECTING_SIZE`.
- **Contextual extraction:** `orderState.extractEntities(text, {awaiting, shownCount, hasSelection})`. A bare "2" is a product pick after a list, and a qty after "how many?". It handles word and Tanglish numbers, labelled or unlabelled addresses sent in several messages, "already sent/paniten", payment questions and "change product".
- **Product lock:** only an explicit change request or a pick from the list on screen can change the product. `update_cart` blocks a model-initiated swap and prefers the customer's own size/qty.
- **Mid-order safety:** a bare team name asks "change it? YES/NO". It never restarts discovery.
- **Response validation:** `_validateReplyAgainstState` rejects LLM replies with a different product, size, qty or price, a re-ask for details on file, a team list mid-order, or a COD offer. It allows one regeneration, then falls back to a deterministic next-step reply.
- **Payment config:** payment answers come only from `config.payment` (`PAYMENT_COD_ENABLED`, `PAYMENT_METHODS`).
- **Concurrency:** a per-sender lock inside `answerQuery` covers all callers. Sessions carry `stateVersion`; `saveSession` refuses a stale write (`'conflict'`) and the turn is re-run once if nothing irreversible happened. Delayed retries are dropped (`stale_retry`) if the customer has messaged since.
- **History:** raised from 4 to 10 messages.

`npm run test-order-state` (`src/test_order_state.js`) replays the production chat and the 10 scenarios against the real pipeline and JSON store, with a scripted fake LLM. Without the lock, the rapid-fire test loses the cart.

### Knowledge Hub (client-editable, self-service bot corrections)

A Wati-KnowBot-style feature: the store owner teaches the bot the right answers through a web
page, and corrections go live immediately — **no code change, no deploy, no dev**. Added
2026-07-20. Runs on the existing JSON-or-Mongo `dbService` pattern (JSON by default; set
`MONGODB_URI` to use Mongo — no code change either way).

**Flow:** (now a section of the unified admin console — `/admin/knowledge`, see "Admin Console")
1. Owner opens `/admin`, signs in with their own account (see "Admin accounts, roles &
   activity log"), and goes to the **Knowledge Hub** section.
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
draft. Runs 20s after boot then every 30 min (`alert:true` → owner WhatsApp ping on
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
`MONGODB_URI` set), knowledge hook in `ai.js answerQuery`, API + review
+ diagnose endpoints in `src/index.js`, UI in the `apps/admin/` React app (`pages/Knowledge.jsx`).
Endpoints: `GET/POST /api/knowledge`, `DELETE /api/knowledge/:id`,
`GET /api/knowledge/review`, `GET /api/knowledge/pending-count`, `POST /api/knowledge/diagnose`,
`POST /api/knowledge/:id/dismiss` (all require a signed-in account with the matching `knowledge.*`
permission).

Verified 2026-07-20: a seeded correction changed a live `answerQuery` reply (intent `knowledge`,
zero LLM); all API auth paths (wrong/right password, missing token, CRUD, review over 60 real
leads) pass; the React page renders in headless Chrome with zero console errors.

### Knowledge Sources — documents + website (RAG), added 2026-07-28

Matches the three "Knowledge source" types the client used in Wati (Website · Document ·
Q&A). Q&A was already the Knowledge Hub above; this adds the other two.

**Flow:** `/admin/knowledge` → **🗂 Knowledge sources** tab → crawl a URL or upload a file.
Text is extracted, chunked (~900 chars, 150 overlap, split on paragraph then sentence
boundaries), embedded, and stored. At answer time the top-3 relevant chunks are injected
into the LLM call.

| File | Purpose |
|------|---------|
| `src/services/textextract.js` | PDF/DOCX/TXT/MD/HTML → plain text; chunking. Rejects scanned/image-only PDFs with an actionable message |
| `src/services/crawler.js` | Same-origin BFS crawl, page/depth capped, 400ms polite delay. `detectBlock()` recognises the Cloudflare/security-plugin signature and returns a fix-the-store message |
| `src/services/embeddings.js` | Two providers: **`local` (default)** = all-MiniLM-L6-v2 @ 384 dims on CPU, or `openai` = `text-embedding-3-small` @ 512 dims. Returns `null` (never throws) on failure |
| `src/services/retrieval.js` | Indexing orchestration + hybrid search + prompt-context builder |

**Retrieval scoring is hybrid.** With embeddings: `0.75×cosine + 0.25×keyword`, threshold
**0.33** (retuned from 0.28 on 2026-07-30 for the local model — see below). Without
embeddings it degrades to keyword-only — but that path is deliberately stricter (≥2
distinct query terms AND ≥50% of terms matched), because a single incidental word match is
very noisy on a jersey catalogue: "who won the 1998 world cup" hit crawled pages containing
"world"/"Cup" until this guard was added.

**Injection point** is `answerQuery` in `ai.js`, right after the Q&A injection and before
the user message — same rationale as that one (keeps the cacheable system-prompt prefix
intact, survives token trimming). It runs only on the LLM path, so the deterministic fast
paths (FAQ, confident Q&A match, size/qty parse, order confirm) stay zero-latency. Costs
nothing when no sources are indexed.

**Storage:** `knowledge_sources` + `knowledge_chunks` (Mongo or JSON, same dual-branch
pattern). Deleting a source cascades to its chunks. Toggling a source off removes it from
retrieval immediately without deleting it. No 1MB cap (Wati's limit) — the admin bar is
informational.

⚠️ **Re-crawling the same URL creates a DUPLICATE source, it does not replace the old one**
(corrected 2026-07-29 — this section previously claimed re-indexing "replaces wholesale",
which is only true *within* one source id). `retrieval.persist()` calls
`dbService.saveKnowledgeSource()` with no `id`, so `db.js` mints a fresh
`src_<ts>_<rand>` every run; `replaceKnowledgeChunks(saved.id, …)` then only replaces the
chunks under that NEW id. The old source and its chunks stay live and both get searched, so
the retriever sees near-identical duplicate chunks. **Delete the existing source before
re-crawling a URL you've already indexed.** (A real fix would be to match an existing
`type:'website'` source by `url` and reuse its id.)

**Endpoints** (all `requireKnowledgeAuth`): `GET /api/knowledge/sources`,
`POST /api/knowledge/sources/document` (multipart, 20MB, memory storage — uploads are never
written to disk), `POST /api/knowledge/sources/website`,
`POST /api/knowledge/sources/:id/toggle`, `DELETE /api/knowledge/sources/:id`.

### Embeddings — local model by default (switched 2026-07-30)

Semantic search previously depended on `OPENAI_API_KEY`, which returns `429 exceeded your
current quota`, so **everything indexed keyword-only**. Replaced with a local CPU model:

| | value |
|---|---|
| Library | `@huggingface/transformers` (the maintained successor to `@xenova/transformers`) |
| Model | `Xenova/all-MiniLM-L6-v2`, int8 ONNX (`dtype: 'q8'`) |
| Dimensions | 384 (was 512 on OpenAI) |
| Cost | **zero** — no key, no quota, no per-call charge, no data leaves the server |
| Footprint | ~130 MB RSS once loaded; ~22 MB model cached in `.models/` (gitignored) |
| Speed (measured) | model load 3.9s cold / 0.2s warm · **17 ms per 900-char chunk** · ~5 ms per query |

Select with `EMBEDDING_PROVIDER=local|openai`. `openai` still works for anyone with a
funded key and falls back to `local` if the key is missing. `EMBEDDING_CACHE_DIR` pins the
model cache (the library's default lives inside `node_modules`, which is root-owned on a
`npm ci` deploy while the service runs unprivileged). `EMBEDDING_WARMUP` preloads the model
~25s after boot so the first customer question doesn't pay the load — automatically skipped
when no knowledge sources are indexed, so an unused feature costs nothing.

**Model loading is a lazy promise-deduped singleton** — concurrent requests share one load
instead of each starting their own 130 MB copy.

**Cross-provider safety:** chunks are stamped with `embeddingModel`, and `search()` treats
any chunk whose vector width ≠ the live query width as un-embedded, routing it to the
keyword branch and logging a re-index warning. Without this a provider switch would score
every stale chunk at cosine 0 — which is *worse* than keyword-only, because the chunk still
looks embedded and so skips the keyword branch entirely.

**Threshold recalibration (why 0.28 → 0.33).** 0.28 was tuned for OpenAI
`text-embedding-3-small`, whose cosine range is compressed; MiniLM spreads wider, leaving
0.28 only ~0.03 above the noise floor. Measured against a clean 5-chunk policy corpus:
on-topic queries **0.407–0.696**, off-topic **0.050–0.248** → any threshold in
(0.248, 0.407] separates them; 0.33 is the midpoint. Erring high is deliberate: a missed
retrieval just means the LLM answers as it normally would, whereas a false positive injects
misleading text into a customer-facing prompt.

⚠️ **A threshold cannot rescue a corpus that lacks the answer.** Re-run against the actual
2026-07-29 theaurax.in crawl and the two bands **overlap**: "who won the 1998 world cup"
scores **0.367**, *above* the genuine "what sizes do you have" at **0.231**. That crawl
indexed product grids, filter sidebars and customer testimonials — no shipping/returns/
sizing prose (see the crawl-coverage note above). Fixing it means re-indexing real policy
content, not moving the number.

**Existing sources must be re-indexed to gain vectors** — the 149 chunks from the
2026-07-29 crawl have `embedding: null` and (separately) exist only in the JSON files, not
in Mongo.

`npm run test-embeddings` (`src/test_embeddings.js`) is the regression suite: 28 checks
covering provider selection, vector shape/normalisation, on-topic retrieval, off-topic
rejection, prompt-context construction, dimension-mismatch handling, and the keyword-only
degradation path. It builds its own clean corpus in memory, so it tests the code rather
than whatever happens to be indexed — no DB, no WhatsApp session, no network beyond the
one-time model download.

**Dependency note:** `@huggingface/transformers` hard-depends on `sharp` for image
pipelines we never use, and `sharp <0.35.0` inherits four high-severity libvips CVEs
(GHSA-f88m-g3jw-g9cj). `package.json` carries an `overrides` entry forcing `sharp ^0.35.3`.
Net new vulnerabilities from this feature: **zero**.

Verified live 2026-07-28: 11/11 API + retrieval tests pass (auth, upload, unsupported-type
rejection, crawl of theaurax.in, invalid-URL rejection, relevant-hit and off-topic-miss
retrieval, toggle on/off, delete cascade), plus a real `answerQuery` run where the bot
answered a 90-day stitching-warranty question using only facts from an uploaded PDF.

**First real website crawl — 2026-07-29 23:29.** `https://theaurax.in` at maxPages 15 /
depth 2 → 15 pages, **149 chunks, 118.1 KB, 0 embeddings** (keyword-only, per the OpenAI
quota note above). ⚠️ **Coverage was poor and it's a BFS-ordering problem, not a bug:** the
15-page budget was consumed almost entirely by `/product-category/*` (alphabetical — 5-slv,
ac-milan, argentina, arsenal, ball, bayern-munich, brazil, chelsea, clrfs, clrhf,
fc-barcelona) plus `/wishlist` and `/my-account`. It never reached shipping-policy, returns,
or about — i.e. the actual policy prose the feature exists to index. Category pages are
product grids and the account pages are empty logged-out shells, so most of those 149 chunks
are low-value. Raising maxPages alone won't fix the ratio. **Proposed but NOT yet
implemented:** a crawler skip-list for `/my-account`, `/wishlist`, `/cart`, `/checkout` and
`?add-to-cart=`-style URLs, plus deprioritising `/product-category/` so the budget goes to
content pages.

**Maintenance-mode 503 (hit + resolved 2026-07-29).** Every URL on theaurax.in — `/`,
`/shop`, `/robots.txt`, `/wp-sitemap.xml`, `www.` — returned an identical 5KB HTTP **503**
regardless of User-Agent. Not Cloudflare: it was the **"CMP – Coming Soon & Maintenance"**
WordPress plugin serving its splash page ("⚠️ Stock Update & Maintenance ⚠️") with
`retry-after: 86400` via Hostinger/LiteSpeed. `crawler.detectBlock()` now sniffs the CMP
signature in the 503 body and names the plugin + the wp-admin fix, instead of the old vague
"usually a Cloudflare challenge page or WordPress maintenance mode". The store owner turned
maintenance mode off the same evening and the crawl then succeeded.

**Admin UX fix 2026-07-29:** the Website URL input's placeholder is now `e.g. https://…`
(`apps/admin/src/pages/Knowledge.jsx`). `addWebsite()` clears the field on success, and a bare-URL
placeholder reads as a filled-in value — so people pressed **Crawl & index** again and got
"Enter a website URL." with no idea why. Admin app rebuilt.

### Missed-message catch-up (added 2026-08-05)

**The bug this closes:** `whatsapp-web.js` only emits `message` for messages that arrive LIVE.
Every emit path in `Client.js` is behind `Msg.on('add', …)` → `if (!msg.isNewMsg) return`
(verified in 1.34.7 — both `onAddMessageEvent` callers, lines 1133 and 1159, are inside that
guard). So two whole classes of customer never reached the bot at all, with **no error and no
log line**:

1. Chats already unread on the phone when the number was first paired.
2. Anything sent while the server was down, restarting, or disconnected.

`src/services/catchup.js` sweeps for them on every `ready` (delayed 15s so the initial chat
sync has settled — `getChats()` straight off `ready` can return a partial list, which would
miss exactly the customers this rescues).

⚠️ **Do NOT use `client.getChats()` — it is all-or-nothing and it failed live.** That helper
maps every chat through `WWebJS.getChatModel` inside one `Promise.all`, and that builder does
a network `groupMetadata.update()` per group plus `WAWebLidMigrationUtils.toPn()` per
participant (`Utils.js:920–1000`). **One bad chat rejects the whole batch.** On the real
LID-based account it died instantly with a minified `[Catch-up] Could not list chats: r`,
silently skipping every waiting customer — the feature looked enabled and did nothing.

`listChatSummaries()` reads the same `WAWebCollections.Chat` store via `pupPage.evaluate` but
extracts only the ~10 fields the sweep needs, **with try/catch around each chat**, so one
unreadable conversation costs exactly one conversation. No metadata fetches, no contact
resolution, no Chat/Message construction. `listChatsFallback()` keeps the library helper as a
last resort. Measured on the live account: **661 chats read in one pass.**

**Detection is the chat's last message, not `fetchMessages()`.** If it is `fromMe`, the
conversation is already answered — including by a human on the shop phone. If it is from the
customer and newer than the watermark, that IS the message to reply to.

**Unhydrated chats are the subtle trap.** WhatsApp does not load messages for every chat
(397 of 661 on the live account). A chat with no readable message AND no unread badge is
genuinely idle → skip. A chat with no readable message but `unreadCount > 0` means a customer
IS waiting and we just cannot see their text → flagged `needsFetch` and rescued by
`fetchLatestInbound()` at reply time, one chat at a time at the drip rate. Live measurement:
**0 such chats on this account**, but the path is covered by the test suite because it only
fires on real data.

**`CATCHUP_DRY_RUN=true`** sweeps and reports without sending, queueing, or alerting — the
only safe way to validate against live customer data. It logs the per-filter breakdown
(`already replied to / handled earlier / groups / idle-unhydrated / rescued`) plus a sample of
who would be answered. Use it before pointing catch-up at a real backlog.

**Two tiers, because the client's requirement was "miss nobody" but a 1000-reply burst is the
most bannable thing an unofficial client can do:**

| Tier | Age | Handling |
|---|---|---|
| 1 (`tierRank 0`) | ≤ `CATCHUP_FRESH_HOURS` (12) | Answered immediately, normal send pace |
| 2 (`tierRank 1`) | older | Persisted, dripped at `CATCHUP_DRAIN_PER_HOUR` (120/h ≈ 1000 chats in ~8h) |

`CATCHUP_MAX_AGE_DAYS` caps how far back a reply will go (**2 days** since 2026-09-19 — the
store owner's instruction was "new messages are enough", because older chats mostly concern
orders that were already sorted out by hand; `0` restores the answer-everything behaviour). Messages ≥24h old get a prefix telling the agent to open by apologising for the
delay, so a month-old message isn't answered as though it just arrived.

**Four invariants worth not breaking:**
- **Persist before answering.** `queueCatchupItems()` runs before any send, so a crash
  mid-catch-up loses nobody. Items are deleted only after a successful send.
- **`tierRank` outranks age in `getCatchupBatch()`.** A plain oldest-first sort puts a
  still-waiting customer from an hour ago *behind* a thousand month-old messages.
- **The drip yields to live traffic** — `drainTick()` returns early while
  `bot.senderChains.size > 0`, so real-time customers always win.
- ⚠️ **`drainFresh()` takes the sweep's own array, never a re-read of the queue.** Reading it
  back returns the OLDEST items — the tier-2 backlog — and answers the whole thing at full
  speed. This shipped once and was caught by the test suite; the check that guards it is
  "answers once the line is clear".

The watermark (`meta` key `catchup:lastSeenTs`) advances on every handled message, live or
caught up. `forgetChat()` drops queued items the moment a customer messages live, so a stale
queued reply can't land in an active conversation. Safe mode applies to the catch-up path too.

Owner gets a WhatsApp summary per sweep (`📥 Missed messages found`) and one when the backlog
finishes draining. `catchupService.getStatus()` exists for a future admin panel but is not yet
wired to an endpoint.

`npm run test-catchup` (`src/test_catchup.js`) is the regression suite — 23 checks against a
stubbed client and stubbed AI, no network, no LLM spend, no WhatsApp session. It resets the
watermark and queue on entry and exit. Covers both read paths (direct + fallback), the
unhydrated-chat rescue, tier ordering, drip yielding, and the double-answer guards.

New state files `src/data/meta.json` + `src/data/catchup_queue.json` (Mongo collections `meta`
and `catchup_queue` when `MONGODB_URI` is set). Both gitignored — per-deployment state.

### ⚠️ WhatsApp account restriction — 2026-09-17 (READ BEFORE TOUCHING ANY SEND PATH)

The client paired a shop phone to try the bot and WhatsApp restricted the number within
minutes: *"Recent activity on your account may be a sign of spam, automated or bulk
messaging — you won't be able to start new chats."* ~5h30m timer, replies still allowed.

**Cause, confirmed in code — it was the catch-up sweep on a cold pairing, not the bot's
normal conversation handling.** Three defaults compounded:

1. **A freshly paired phone has no watermark.** `sweep()` read `catchup:lastSeenTs` as `0`,
   so *every* chat in the account's history where the customer spoke last counted as
   "missed" — 661 chats on this handset, going back months.
2. **`drainFresh()` had no ceiling.** Everything inside `CATCHUP_FRESH_HOURS` (12h) was
   answered in one uninterrupted loop. The global send pacer only *spaced* those sends; 60
   first-contact messages 2s apart is still 60 new conversations in two minutes.
3. **`maxSendsPerMinute` was 30.** That is a fast human inside ONE chat. Across 30
   *different* chats it is a broadcast — and WhatsApp measures per account, per recipient.

`CATCHUP_MAX_AGE_DAYS=0` (no age limit) and the 120/h drip made it worse: unprompted replies
to months-old chats read as outreach, not as answers.

**Fixes shipped the same day** (`config.js`, `catchup.js`, `followup.js`, `whatsapp-web-bot.js`):

| Guard | Where | Default |
|---|---|---|
| `catchup.coldStartHours` — a zero watermark looks back only this far | `catchup.js sweep()` | 24h |
| `catchup.freshMaxImmediate` — cap on the tier-1 burst; the rest join the drip | `drainFresh()` | 5 |
| `catchup.maxAgeDays` — never answer older than this | sweep filter | 2 (was 0 = unlimited) |
| `catchup.drainPerHour` | drip | 20 (was 120) |
| `whatsappWeb.maxSendsPerMinute` | `awaitSendSlot()` | 8 (was 30) |
| `whatsappWeb.minSendGapMs` / `sendJitterMs` | `awaitSendSlot()` | 4000 / 3000 (was 1200 / 900) |
| `whatsappWeb.maxNewChatsPerHour` — distinct chats per rolling hour | `chatBudget()` | 30 |
| `followUp.enabled` / `maxPerRun` — kill switch + per-run cap | `followup.js` | true / 8 |
| `followUp.cooldownHours` — minimum gap between two nudges to one person | `followup.js` | 24 |
| `followUp.maxLeadAgeDays` — never nudge a lead quieter than this | `followup.js` | 3 |

Tier-1 sends now also count against `sentThisHour`, so a burst of recent customers correctly
slows the backlog instead of being free.

⚠️ **`chatBudget()` is a question the caller asks, never a wait inside `awaitSendSlot()`.**
The send chain is global, so enforcing an HOURLY budget in there would park a live customer's
reply behind the backlog for up to an hour — trading a ban risk for the exact failure
(unanswered customers) catch-up exists to prevent. Bulk paths consult it and defer to the
next tick; live replies are never blocked by it.

⚠️ **The cold-start guard applies only when the watermark is 0.** Once a real watermark
exists it is authoritative, otherwise a server that was down for two days would permanently
ignore those two days. Both halves are covered in `npm run test-catchup` (case 9).

**Operational rules that matter more than the code:**
- **Always run `CATCHUP_DRY_RUN=true` the first time the bot is pointed at a real phone.** It
  prints exactly who would be answered and messages nobody. This incident is what it was
  built for, and it was not used.
- **A number must be warmed up before it carries bot traffic.** A SIM with no outbound
  history that suddenly starts dozens of conversations is the strongest signal there is;
  account age and prior two-way history are weighted heavily.
- **Never clear `.wwebjs_auth/` or the data dir on a live number without also setting
  `CATCHUP_COLD_START_HOURS`** — wiping state resets the watermark to 0, which reproduces
  exactly this incident.
- Customer **blocks and "report" taps are the dominant input** to the classifier. Pacing
  reduces exposure; it does not help if the replies themselves are unwanted.

### Customer Registry

Every customer interaction upserts a record in `src/data/customers.json` (or MongoDB `customers` collection). Use `dbService.getAllCustomers()` to retrieve all contacts for product launch campaigns or bulk messaging.

### Cold Lead Follow-Up

`src/services/followup.js` runs a check every 30 minutes. Any active lead inactive for 3+ hours
(up to 2 times, lifetime — `followUpCount` is never reset) gets a personalised re-engagement
message via WhatsApp. Cart contents are referenced in the message if available.

**Four guards decide who is eligible**, and they exist because this is the only path that
messages someone who did not just write to us:

| Guard | Default | Stops |
|---|---|---|
| `maxPerLead` | 2 | a third nudge to the same person, ever |
| `cooldownHours` | 24 | nudge #2 landing 30 minutes after nudge #1 |
| `maxLeadAgeDays` | 3 | re-engaging a chat that went quiet weeks ago |
| `maxPerRun` + `chatBudget()` | 8 / 30 per hour | one run turning into a broadcast |

⚠️ **`cooldownHours` is the one that isn't obvious** (added 2026-09-19). Eligibility is measured
from `lead.updatedAt`, i.e. the CUSTOMER's last message, and `updateLeadFollowUp()` only writes
`followUpCount` + `lastFollowUp` — it deliberately does not touch `updatedAt`, since that field
means "last customer activity". So the instant nudge #1 goes out the lead is *still* overdue, and
the next 30-minute run sent nudge #2 immediately: two near-identical "still interested?" texts
half an hour apart, which is exactly what a customer reads as a bot stuck in a loop. The cooldown
is measured from `lastFollowUp`, not `updatedAt`.

`npm run test-followup` (`src/test_followup.js`) is the regression suite — 16 checks against a
stubbed bot and stubbed DB, nothing sent, no network. It pins the config knobs itself so a local
`.env` with follow-ups disabled can't turn it into a no-op that passes.

### WooCommerce REST blocked — use an Application Password (2026-09-20)

`npm run sync` and `woocommerce.createOrder()` share one authenticated `wp-json/wc/v3` client,
so a single block takes out **both** the catalogue refresh and order creation. That is exactly
what happened: last successful sync **2026-08-05**, last bot-created order **#77992 on
2026-08-07**, and for six weeks every confirmed order silently fell back to a PDF invoice with
no payment link.

Two gates were found on theaurax.in, both 401:

| Request | Response |
|---|---|
| any REST route, no credential | `rest_login_required` — the `Disable WP REST API` plugin |
| any REST route + a **valid** consumer key | `{"success":false,"message":"API is working, Site Connected"}` |
| any REST route + a well-formed **fake** key | `rest_login_required` |

The second gate is the odd one: it fires only for a consumer key that **exists in the
database**, on every REST route (not just `wc/v3`), whether or not the secret is right. That is
a deliberate key lookup, not a generic security plugin. It is also why the key's **Last access**
in WooCommerce read *Unknown* — WooCommerce stamps that field only after authenticating a
request itself, and the request never reached it. A 401 alone tells you none of this, which is
what `npm run check-woo` exists to say out loud.

**The way through is `WOOCOMMERCE_APP_USER` / `WOOCOMMERCE_APP_PASSWORD`** (WP Admin → Users →
Profile → Application Passwords). An app password is not a consumer key, so the interceptor
ignores it, and it authenticates as a real WP user, which also satisfies `Disable WP REST API`.
Same endpoints, same code path — only the credential differs, and the client prefers it over
the consumer key whenever both are set.

- The WP user must be **Administrator or Shop Manager**, else auth succeeds and `wc/v3` 403s.
  The working account is `TheAurax`.
- ⚠️ The consumer key started returning 200 again mid-session on 2026-09-20 while the store
  owner was in wp-admin. **The interceptor's trigger is not understood and may come back** —
  keep the app password configured as the primary credential regardless.
- ⚠️ Separately, that site's **Plugins screen hides most of its plugins** (it lists 4; at least
  9 more are confirmed on disk, WooCommerce among them) and 3 of the 4 it does list have no
  matching plugin folder. Unresolved — see `theaurax_context.md` 2026-09-20 §2 before trusting
  anything that screen says.

### Store facts worth knowing before touching the order flow

Verified live 2026-09-20 via REST:

| | |
|---|---|
| Payment gateways | **Razorpay only.** `cod`, `bacs` and `cheque` are all disabled |
| Unpaid order lifetime | `hold stock = 60 minutes` — WooCommerce cancels unpaid `pending` orders and kills their payment link |
| Stock counts | **None.** `manage_stock=false` and `stock_quantity=null` across the catalogue; 92 of 100 sampled products are variable. Only `instock`/`outofstock` is knowable |
| Products | 136 published · **655 draft** (566 priced, 541 in stock, 139 Player Version, 111 Fan Version, 14 × 26/27) |

✅ **COD was purged 2026-09-21.** The bot had promised Cash on Delivery in `faq.json[1]` and
`[2]` (including a "₹50 COD fee"), in both worked examples, and in all three order-confirmation
templates — while Razorpay has always been the only enabled gateway. Every one of those now
says prepaid only, and a `PAYMENT — PREPAID ONLY (CRITICAL)` block in the system prompt tells
the agent to refuse COD even when the customer insists. Asking "COD available?" gets an honest
no plus the methods that do work. **With COD gone the prepaid shipping rate is the only rate,
so the FAQ now says shipping is free on every order** — that was the open question in the
rework plan and this is the assumption it shipped under; correct the FAQ if the owner charges
for delivery on some orders. `npm run test-order-flow` fails if a COD promise reappears.

### Order confirmation integrity (fixed 2026-09-21)

**The bug:** from 2026-08-07 to 2026-09-21, when `createOrder()` failed, *both* confirmation
paths still sent "Your order is confirmed!", wiped `cart`/`address`/`history`, and saved the
lead as `status:'completed'` — with no order in WooCommerce, no owner alert, no ticket. The
deterministic path attached a proforma PDF in place of a payment link, which made it look more
official still. The LLM path returned `status:"success"` with "Order noted manually", so the
model confirmed warmly too. For six weeks the REST API was blocked, so this was *every* order.

| Piece | Where | Rule |
|---|---|---|
| `_confirmOrderNow()` | `ai.js` | returns `created` — true ONLY with a real WooCommerce order ID. Callers may not read anything else as success |
| `_recordOrderFailure()` | `ai.js` | keeps the cart, sets `CONFIRMING_ORDER`, opens an `order_failed` ticket, pings the owner. Shared by both paths |
| `_handleOrderFailure()` | `ai.js` | the deterministic reply: says plainly it did not go through, gives the ticket ref, invites a one-word retry |
| LLM `confirm_order` | `ai.js` | `status:"error"` on failure, with explicit instructions not to thank, confirm, invent an ID or give a link |
| `isConfirmed` | `ai.js` | set only after an order ID exists — it is what wipes the session |
| proforma PDF | removed | it only ever fired on the FAILURE path; an invoice with no way to pay is what made the false confirmation convincing |

⚠️ **The cart is deliberately NOT cleared on failure**, and the session stays in
`CONFIRMING_ORDER`, so the customer's next "yes" retries the whole thing in one word. An
automatic background retry was NOT added: without an idempotency key against WooCommerce it
risks placing the same order twice.

**Boot health check.** `woocommerceService.checkOrderingHealth()` probes `GET /orders` at boot
(+6s) and every 15 minutes, setting `orderingAvailable`. While it is `false` the agent does not
even attempt checkout — it goes straight to the honest failure path and a human. Order READ is
probed because it needs the same capability as order WRITE, so it proves the write path without
placing a live order. A timeout or 500 does NOT flip the flag (only 401/403 does), so one blip
cannot send every customer to a human. This is the check that would have caught the six-week
outage on day one.

`npm run test-order-flow` — 43 checks against a stubbed WooCommerce, DB and WhatsApp client.
Nothing is ordered, nothing is sent.

### Constraint-aware product search (fixed 2026-09-21)

From the 2026-09-20 tester reviews — the bot faked a match rather than admit a miss:

```
"Real Madrid 26/27 all kit jerseys" → REAL MADRID 14-15 / 17-18 / 11-12   (season ignored)
"Player version 26/27"             → CSK 2025 ₹350, RCB 2026 ₹360        (cheapest filler)
"Ac Milan jerseys iruka bro?"      → "Can you be more Specific"           (never searched)
```

| Cause | Fix |
|---|---|
| The token filter dropped everything numeric, so `26/27` was invisible and every Real Madrid shirt since 1998 scored the same | `parseSeasons()` canonicalises `26/27`, `2026/27`, `1996-97` and bare `2026` to comparable two-digit forms, applied as a **filter** |
| Zero matches silently became the five cheapest in-stock products, labelled "Found products" | `searchProductsDetailed()` returns `matchQuality` `exact`/`partial`/`none` and keeps filler in a separate `suggestions` field |
| The hype opener was unconditional — "Semma choice bro! 😍" over whatever came back | Hype is reserved for `exact`. `partial` leads with what we do NOT have; `none` admits the miss |
| Search context died each turn, so the follow-up lost the team | `extractSubject()` + `_mergeSearchContext()` carry the team into a constraints-only follow-up |

⚠️ **`searchProducts()` now returns `[]` on a miss, never filler.** Anything presenting its
result to a customer must use `searchProductsDetailed()` and honour `matchQuality` — which since
2026-09-22 has a fourth value, `'broad'`; see the section below.

⚠️ **A season bonus is a TIEBREAKER, never a qualifier.** Scoring it before the `score > 0`
gate made an RCB 2026 shirt "match" *Real Madrid 26/27* — the same class of bug as the old
in-stock-weight one. When the requested season is unavailable, results are re-sorted newest
first, so a 26/27 request leads with 25-26 rather than an arbitrary 11-12.

Two further bugs found while testing this: `"bro"` was matching the category *"Signature
Embroidery"* by substring (categories are now matched whole-word, and Tanglish filler is in the
stop-word list), and one published product, *FC BARCELONA X ED SHEERAN 25-26*, genuinely carries
an **"AC Milan" category** in WooCommerce — a catalogue error to fix in wp-admin, not in code.

**Player/Fan Version currently never matches, and that is correct:** all 139 PV and 111 FV
products are DRAFTS, so nothing published carries the marker. The bot now says so instead of
substituting an IPL shirt. Publishing those drafts is still the store owner's decision.

`npm run test-search` — 60 checks, including the real `answerQuery` reply path with a stubbed
LLM. That last part matters: `node --check` cannot see an undefined variable inside the tool
handler, so only executing it catches a half-applied edit.

### A query that names nothing is not a match — `matchQuality: 'broad'` (2026-09-22)

The last place the bot still sounded certain about nothing. *"Yennaku 3 jersey venum"* ("I want
3 jerseys") names no team, so `search_products` ran on `"jersey"` — and the substring rule
matched **the entire catalogue** on the word JERSEY in every product name, scored all 136 shirts
identically, and `finish()` labelled them `exact`. The customer got *"Bro kandippa iruku! 🔥"*
("we definitely have it!") over three unrelated shirts.

Same class as the old in-stock-weight bug and the 2026-09-20 filler bug: **a match on something
that carries no meaning is not a match.**

- `searchProductsDetailed()` returns `matchQuality: 'broad'` when every token was a stop word
  AND there is no season, version, price limit, cheapest or bestseller angle to rank on. It is
  its own quality rather than `'none'` because nothing failed — the customer just has not said
  what they want yet, and *"sorry, couldn't find it"* would be dishonest in the other direction.
- The reply is `teamListReply()` — the same catalogue-grounded list the deterministic
  "which teams?" path uses, because the blocker is the missing team, not the product.
- ⚠️ **`session.lastShownProducts` is cleared on a broad result.** The suggestions are never
  shown, so a later *"1st one, M, 2"* must not resolve against a list the customer never saw.
- ⚠️ **The gate is narrow on purpose.** `jerseys under 700`, `cheapest jersey`, `best selling
  jersey`, `kids jersey` and `26/27 jersey` all still search normally; widening `isBroadQuery`
  by accident would silently disable every one of them. `npm run test-tanglish` pins all five.
- Tanglish pronouns (`yennaku`, `enaku`, `naan`, `neenga`, `unga`, `kitta`, `thevai`…) joined the
  stop-word list. Without them *"Yennaku 3 jersey venum"* searched on `yennaku`, matched nothing
  and reported `'none'` — a *miss*, when the truth is the customer had not named a team yet.

### Never offer a team we don't carry (2026-09-22)

NEVER INVENT PRODUCTS stops the bot naming a *product* it has not searched. It said nothing
about naming a **team**, and the model used the gap twice:

```
2026-09-21  "IPL team ah irundha CSK, Mumbai Indians, Rajasthan Royals kooda iruku"
2026-09-22  "say PSG, Real Madrid, Inter Milan"        ← after the first round of fixes
```

Real Madrid, CSK and Mumbai Indians are real. **PSG, Inter Milan and Rajasthan Royals are not in
the catalogue at all** — the customer is sent off to ask for something that will never arrive.

`woocommerceService.unstockedTeamsMentioned(reply)` scans a reply against a fixed list of clubs
and national sides a football-literate model reaches for, and returns the ones the **real
catalogue** does not carry. It is a failure class in the loop: one regeneration naming only the
real list, then `teamListReply()` replaces the answer outright.

- ⚠️ **The known-team list is never used to search or suggest — only to check.** Stocked names
  are not excluded by hand either: each is tested against the catalogue, so publishing a PSG
  shirt tomorrow makes PSG a legal thing to say with **no code change**.
- ⚠️ **Whole-phrase containment, not word lookup.** `milan` is in the catalogue (AC Milan) while
  `inter milan` very much is not, so matching on words would clear it. `catalogueText()` is the
  space-normalised concatenation of every product name and category, memoised.
- Mumbai Indians is correctly **not** flagged: it is in the catalogue, just out of stock. The
  check answers "do we carry this team", not "can we ship it today".

⚠️ **`teamListReply()` does not print the same twelve lines twice in a row.** If the previous
assistant turn was byte-identical to the list it is about to send, it points back at it instead
("pick one from the list above"). Repeating an identical block is what a stuck bot looks like —
the same failure the follow-up `cooldownHours` was added to stop on 2026-09-19. The comparison
is against the full generated string, so it can only ever match our own list.

### Guided browse — for the customer who doesn't know what you sell (2026-09-22)

Every path before this assumed the customer could already name what they wanted. Someone who
has never seen the shop cannot: asked *"which team?"* they have nothing to answer with, and the
2026-09-21 chat is four turns of exactly that standoff. The team list fixed half of it — this
is the other half, for the customer who doesn't know they want a football shirt at all.

**Three steps, no LLM call anywhere in the journey:**

| Step | Trigger | Reply | Intent |
|---|---|---|---|
| 1 | `asksWhatWeSell()` — "what do you have", "suggest something", "I don't know", "enna enna iruku" | the kinds of product we stock, numbered, with real example teams and a count | `deterministic_browse` |
| 2 | a number or a word matching one of them (`matchGroupChoice()`) | that group's **actual best sellers** by `total_sales` | `deterministic_browse_pick` |
| 3 | "1", or "1 M 2" | straight into the existing cart flow — no new ordering code | `deterministic_cart` |

Step 2 sets `session.lastShownProducts`, which is the whole trick: the existing
`parseSizeQtyReply` / product-selection fast paths take over from there, so a customer goes from
*"I don't know what to buy"* to `COLLECTING_ADDRESS` in three messages without the LLM being
asked anything. Deterministic not just to save calls — a customer being shown the shape of the
shop is exactly when an invented category does the most damage, because they have no way to
tell it is wrong.

⚠️ **Grouping reads the product NAME, not just its categories, and that is load-bearing.**
Measured on the live cache: **21 of 99 in-stock products carry no team category at all** —
`REAL MADRID HOME 17/18 FULL SLEEVE`, `PORTUGAL AWAY WC RN`, `ASTON VILLA 2020-21` are all
uncategorised in wp-admin. Category-only grouping loses a fifth of the shop and badly understates
the rest: **Portugal has one product in its category and six by name**, including the
best-selling shirt in the entire catalogue (104 sales). Name-based grouping places 96 of 97
in-stock priced products; the one straggler is a Nike mash-up that belongs to no team.

⚠️ **`teamPatterns()` and `knownTeamNames()` are recognisers, never suggesters.** A name in
either list that the shop does not stock is never emitted anywhere, because nothing is printed
unless a real in-stock product matched it. `"Baryen Munich"` is in there deliberately — it is
the spelling one live product uses, and without it that shirt is invisible to the Bayern group.

⚠️ **`asksWhichTeams()` must actually say "team"/"club"/"country".** It used to accept a bare
`"enna enna"`, which swallowed every open-ended Tanglish opener before the browse menu could see
it — *"enna enna iruku bro"* got a wall of twelve club names instead of the five product kinds.
The team question keeps the team list; the open-ended question gets the menu. `npm run
test-tanglish` pins both directions.

⚠️ **`session.pendingBrowse` is read and cleared on the very next turn, resolved or not.** A
customer who ignores the menu and types "Real Madrid" gets a normal search — and crucially does
not leave a live "pick a category" state behind for an unrelated `"2"` three turns later to be
swallowed by. `matchGroupChoice()` returns null on anything vague rather than guessing, and null
always falls through to the agent.

⚠️ **The egress sanitiser compares with whitespace ignored.** Some WooCommerce product names
genuinely carry double spaces (`HOME —  MESSI`), and the sanitiser tidies those, so a plain `!==`
logged a leak warning on every healthy product reply — which is how a real warning ends up being
ignored.

### Machine output must never reach a customer — one egress (2026-09-22)

The client's report was *"I've tested yesterday and right now still I'm getting mistakes —
mistakes even in the language (tanglish)"*. The chat behind it (2026-09-21 15:27–15:30) put two
pieces of machine output in front of a real customer, inside otherwise normal sentences:

```
"Team perai sollu, best options kaanpida*ven*! 🔥"      ← markdown marker wedged mid-word
"3 jersey ready p\"{ Oru pechu sollu, fast! 🔥"          ← raw escape/JSON fragment
```

**Why the existing stripping missed both.** It lived inside ONE branch of the agentic loop
(the free-text branch of `answerQuery`) and matched only leaks that were a *whole, well-formed
tool call*. A fragment in the middle of a sentence was not a whole call, so nothing matched;
and no code anywhere looked at asterisks.

Cleaning is now a property of the **exit, not of a branch**:

| Piece | Where | Rule |
|---|---|---|
| `answerQuery()` | `ai.js` | a thin wrapper; all the work moved to `_answerQueryImpl()` |
| `sanitizeOutgoing()` | `ai.js` | every reply passes through it exactly once, on the way out |
| `looksCorrupted()` | `ai.js` | structural machine output — worth one regeneration |
| `repairEmphasis()` | `ai.js` | mid-word and unbalanced `*` markers |
| `brokenReplyFallback()` | `ai.js` | what to say when the reply *was* the leak |

⚠️ **`answerQuery` is a wrapper on purpose.** `_answerQueryImpl` has eleven `return`s (FAQ,
knowledge, reset, size/qty, selection, confirm, order-failure, quota, error, agent…), so a line
at each one is a line someone forgets on the twelfth. The wrapper covers paths added later for
free. **Never `return` a reply from anywhere else.**

⚠️ **A token carrying `{`, `}` or `\` is removed WHOLE, not character by character.** Cleaning
`p\"{` per character leaves a stray `p` sitting in the sentence, which reads as a typo the
customer asks about. No jersey name, price, size, URL or Tanglish sentence has ever legitimately
contained one of those three characters — which is also why their presence alone is proof of a
leak, however healthy the rest of the reply looks.

⚠️ **The loop judges the RAW model output, never the sanitised text.** Sanitising always
succeeds — that is its job — so a check made afterwards reports a healthy reply every time and
the regeneration never fires. The loop spends **one** regeneration (shared budget with the
forced-search nudge) and the sanitiser is the guarantee behind it, not the other way round.

⚠️ **Structural failure and language failure recover differently.** A leak, an empty reply or a
greeting-leak means the answer cannot be trusted at all, so it is replaced with a deterministic
product list. A reply whose only fault is an odd Tamil word still answers the question — it is
kept (cleaned) rather than swapped for an unrelated list.

⚠️ **The sanitiser also sits in front of the store's own FAQ and Knowledge Hub answers.** An
over-eager rule would silently rewrite what the owner typed. `npm run test-tanglish` asserts
every `faq.json` answer passes through byte-identical.

### Tanglish quality — three defences, in order of worth (2026-09-22)

The same chat shows the other half of the complaint: Tamil-shaped words that mean nothing.
*"Which team or player **theekana** jersey venum"*, *"**Chuuda**, endha team venum"*, *"Oru team
**pechu sollu**"*, *"best options **kaanpidaven**"*. None is a word. This is what a model does
when it samples freely in a language it only half knows — romanised Tamil has no standard
spelling to anchor on, so a plausible-looking syllable string is as likely as a real one.

1. **Don't let it write free Tanglish when a template will do.** Already true for product
   listings, and it shows: the templated replies in that screenshot were the good ones.
2. **Sample colder.** `temperature` is now **0.3** for Tanglish (0.15 on later attempts) versus
   0.7 for English, in `callLLMWithRetry`. Nothing is lost — the hype and the formatting come
   from deterministic templates, so the free text only has to be correct, not inventive.
3. **A closed phrasebook in the prompt**, plus the rule that carries the most weight: *if you
   are not certain a Tamil word is real, use the plain English word instead.* A Tanglish speaker
   mixing in more English reads completely normal; invented Tamil does not.

`tanglishProblems()` is the backstop, not the fix: it names the specific broken forms seen in
production, asks for one rewrite, and fails the test suite if any of them reaches a reply again.
It returns `[]` for English sessions, so it costs those nothing.

⚠️ **The prompt names bad Tamil WORDS but never a bad output FORMAT.** That asymmetry is
deliberate and measured — see the comment above `generateSystemPrompt`, where spelling out the
forbidden tool-call format raised `tool_use_failed` from 30% to 95%. Vocabulary is not a token
sequence the constrained decoder can be primed into emitting; a wire format is.

### Two questions the agent had no answer for (2026-09-22)

Both are from the same chat, and both were being answered by a model with nothing to ground it:

- **"Enna enna team la iruke?"** ("which teams do you have?") carries no search term, so
  `search_products` returns nothing and no tool answers it. The agent invented a list — *Mbappe,
  Haaland, CSK, Mumbai Indians, Rajasthan Royals* — breaking the NEVER INVENT PRODUCTS rule, and
  asked *which team?* back at the customer three times in a row. `woocommerceService.listTeams()`
  now reads the answer straight out of the in-stock cache (intent `deterministic_teams`).
  Non-team categories are filtered out: the store also uses categories for print style (`RN:HS`,
  `CLR:FS`), sleeve length (`5-SLV`), audience (`Kids`) and merchandising, and casing is
  normalised because wp-admin holds `LiverPool`, `GERMANY` and `FC Barcelona` side by side.
- **"Enna bro pesuradhe purila"** ("I can't understand what you're saying") is the clearest
  signal there is that the Tanglish did not land — and it was answered with *more* invented
  Tamil. Handled in code now (intent `deterministic_clarify`), because the recovery must not be
  written by the thing that just failed: apologise once, then say it again in mostly plain
  English with the real team list attached, so the next turn has something concrete to reply to.

`asksWhichTeams()` deliberately returns false when `extractSubject()` finds a real team in the
message — *"Barcelona team jersey iruka?"* is a search, not a range question.

### Cold-lead follow-ups now speak the customer's language (2026-09-22)

`followup.js` sent English to everyone, so a customer whose whole conversation was Tanglish got
an unprompted English nudge hours later. It is also the one customer-facing path that **bypasses
`answerQuery` entirely** — it speaks first, so the egress sanitiser never sees it. The copy is
therefore hard-coded in both languages and covered by `npm run test-tanglish`; the language comes
from the session (the authority, since it is locked there for the whole conversation), and a lead
whose session cannot be read gets English, which is what it would have got anyway.

`npm run test-tanglish` — 182 checks against the real sanitiser, the real catalogue helpers and
the real `answerQuery` egress with a stubbed LLM. No network, no LLM spend, nothing sent,
nothing ordered; it writes to a temp `AURAX_DATA_DIR` and never touches live data.

### Product Cache

`src/data/products_cache.json` is a local snapshot of WooCommerce products, including `total_sales` (synced from WooCommerce). Run `npm run sync` to refresh it. The search uses token-matching with relevance scoring — no embeddings or vector DB. Queries with genuine keyword/category relevance are scored and ranked; stock status is only a tiebreaker among already-relevant matches, never a standalone qualifier (a prior bug had every in-stock product score >0 regardless of relevance, so a query with zero real keyword overlap returned ~10 arbitrary products instead of falling back cleanly). "Best selling / popular / trending" queries are detected and ranked by `total_sales` instead of falling through to the generic relevance path.

### WhatsApp Connection

On first run, open the admin console (the Vercel URL, or `http://localhost:3000/admin`), sign in, and go to the **WhatsApp** section to scan the QR code. Auth is persisted in `apps/bot/.wwebjs_auth/` (Puppeteer LocalAuth). The bot auto-reconnects on disconnect with a 10-second delay. (The old `/whatsapp-link.html` URL now 302-redirects to `/admin/whatsapp`.)

**Linked-account panel + remote logout (added 2026-08-04).** While `CONNECTED`, the WhatsApp
section shows **which number the bot is actually paired to** (number, account name, device
platform, linked-since) plus a **Log out this number** button. Previously nothing in the product
recorded whose phone held the session, so finding it meant checking "Linked devices" on every
candidate handset; and moving the bot to a different number meant SSH-ing in to delete
`.wwebjs_auth/`.

- `client.info` is captured on the `ready` event into `whatsappWebBot.deviceInfo` and returned by
  `getStatus()` as `device` — but **only while `CONNECTED`**, so a stale number can never appear
  next to a disconnected badge.
- `POST /api/whatsapp/logout` (auth) → `whatsappWebBot.logout()` calls `client.logout()`, which
  revokes the session on the phone AND clears the LocalAuth folder. `destroy()` alone would not:
  the next `initialize()` would silently re-pair the same number, so "logout" would log nothing
  out. It then re-initializes after 2s so a fresh QR appears without a restart.
- ⚠️ `logout()` detaches `this.client` **before** awaiting, because `client.logout()` fires the
  `disconnected` event — which has its own destroy + 10s reconnect. Both paths now route through
  `scheduleReinit()` (single shared timer) and the `disconnected` handler bails out when
  `this.client` is already null. Without both guards a logout races into **two Puppeteer clients
  on one LocalAuth session**, which corrupts it.
- If `client.logout()` throws (page already gone), the response says so — `cleared: false` plus
  instructions to delete `.wwebjs_auth` — rather than reporting a clean unlink that didn't happen.

Verified 2026-08-04 (12 checks, `logout()` driven against a stubbed client): refuses cleanly with
no session, hides stale device info, detaches the client, clears device state, reports the
previous number, runs exactly one re-init when a late `disconnected` races it, and degrades
honestly when the unlink fails.

**Phone-number linking (added 2026-09-16).** The WhatsApp section has a **Link with phone number
instead** button: the admin enters the number, the console shows WhatsApp's 8-character code, and
it's typed on the phone under Linked devices → Link a device → *Link with phone number instead*.
Added because the phone refused the server's QR with *"Couldn't link device. Try again later."*
while the same phone linked web.whatsapp.com on a laptop fine — i.e. the refusal was specific to
the server, not the account.

- `POST /api/whatsapp/pair` `{phoneNumber}` → `startPhonePairing()`; a bare 10-digit number gets
  `91` prefixed. `POST /api/whatsapp/pair/cancel` → back to QR. Both refuse while `CONNECTED`.
- whatsapp-web.js picks QR vs code **once, inside `initialize()`**, so switching mode tears down the
  unpaired client and builds a new one with `pairWithPhoneNumber` (`restartForLinking()`). Status
  becomes `CODE_READY`; `getStatus()` returns `pairingPhone`/`pairingCode`. The library re-requests
  a code every 180s. `ready` clears the pairing state so later reconnects restore the session normally.
- **Real browser identity.** whatsapp-web.js's default `userAgent` claims *Chrome 101 on macOS
  10.14*; production actually ran Chrome 146 on Linux (seen in `ps` on the VPS, 2026-09-16), so
  the UA contradicted the browser's own client-hint headers — an obvious automation fingerprint
  and a suspect for the linking refusal. `realChromeUserAgent()` now builds the UA from
  `puppeteer.PUPPETEER_REVISIONS.chrome` + the host OS. Override with `WHATSAPP_USER_AGENT`.
- ⚠️ Every client event handler and the `initialize().catch` now check `this.client !== client`.
  Destroying a client mid-launch rejects its `initialize()`, and without the guard that late
  rejection nulls out and re-inits over the **replacement** client.

### Admin Console (unified Vite + React app)

Added 2026-07-22. The three former standalone pages (`apiwork.html` monitor, `whatsapp-link.html`
QR link, `knowledge-hub.html`) are consolidated into **one** proper React SPA under `apps/admin`
(Vite build, react-router, react-chartjs-2) — light/clean/professional theme, mobile + desktop
responsive, with a sidebar: **Monitor · WhatsApp · Knowledge Hub · Tickets · Users & Roles · Activity Log**.
Every page and API is behind a per-person sign-in with role-based permissions (next section).

- **Source:** `apps/admin/` (its own npm package, not a workspace: `src/{main.jsx,App.jsx,contexts.jsx,api.js,sections.js,styles.css}`,
  `src/components/{Login,Layout,Modal}.jsx`, `src/pages/{Monitor,WhatsApp,Knowledge,Tickets,Users,Activity}.jsx`).
- **Dev:** `npm run dev-admin` from the root (Vite on :5174, proxies `/api` + `/invoices` to the bot on :3000).
- The old `.html` URLs 302-redirect to the matching `/admin/*` section; `/` redirects to `/admin`.

### Admin accounts, roles & activity log (added 2026-09-17)

Replaced the shared team passwords (`AURAX_TEAM_PASSWORD` / `TESTING_TEAM_PASSWORD`), which gave
every holder full access with no way to remove one person. Now each person has their own email +
password, and a **role** decides which pages they can open and what they can change. The client
asked for this so testers get limited, professional access instead of the master password.

**Files:** `src/services/adminAuth.js` (permission catalog, scrypt hashing, sessions, account rules,
`requirePermission()` guard, `record()` for the activity log), `src/routes/admin.js` (mounted at
`/api`: `auth/login|me|logout`, `admin/users`, `admin/roles`, `admin/activity`), `src/services/mail.js`
(Brevo), `src/admin_user.js` (Owner recovery CLI), `src/test_admin_auth.js` (regression suite).
Storage follows the dual pattern: `admin_users`, `admin_roles`, `admin_sessions`, `admin_activity`
(Mongo collections or `src/data/admin_*.json`, all gitignored).

**Permissions** (`PERMISSIONS` in adminAuth.js): `monitor.view`, `whatsapp.view`, `whatsapp.manage`,
`knowledge.view`, `knowledge.edit`, `knowledge.sources`, `tickets.view`, `tickets.manage`,
`users.manage`, `activity.view`. Anything on a page implies that page's view permission
(`normalizePermissions`). The Owner role is `['*']`, locked, and is the only thing that satisfies the
pseudo-permission `'owner'` (used for `POST /api/provider-stats/reset`, which has no UI). Built-in
roles seeded on an empty store: Owner, Tester, Viewer. The console's `sections.js` uses the same keys.

**Enforcement is server-side on every route** (`requirePermission('…')` in index.js). The console
hiding a page or button is cosmetic only.

- **Passwords:** the owner chooses (or generates) the password and it is final — no temporary
  password, no forced change, no self-service change or "forgot password" yet (client decision
  2026-09-17). Hashed with Node's built-in `crypto.scrypt`; params stored in the hash string.
- **Sessions** are persisted (`{ id: sha256(token), userId, expiresAt }`, 7-day default), so a
  restart no longer logs everyone out, and a leaked sessions file can't be replayed. `authenticate()`
  caches for 15s but **every account/role write calls `invalidate()`**, so a role change, disable or
  password reset takes effect on the person's very next request — the suite checks this.
- **Guard rails:** can't disable/delete/demote yourself; the last active Owner can't be removed;
  only an Owner can assign the Owner role or touch an Owner's account; a non-Owner with
  `users.manage` can't grant permissions their own role lacks or edit their own role; a role in
  use can't be deleted. 5 wrong passwords lock an account for 15 min (owner can Unlock), plus a
  30-attempts/15-min per-IP limit.
- ⚠️ **`/api/whatsapp/status` strips `qrDataUrl` and `pairingCode` without `whatsapp.manage`.**
  Either code lets whoever sees it link their own phone as the bot's number, so a view-only tester
  must never receive them.
- **Email (Brevo):** creating a user or setting a password emails the login (sign-in link, email,
  password) via `POST https://api.brevo.com/v3/smtp/email`. Sending never throws — the account change
  stands and the API returns `mail: { sent:false, error }`; the console then shows the details once
  on screen with a copy button. Unset `BREVO_API_KEY` = same fallback. Passwords are never logged
  (server logs are visible on the Monitor page), but **Brevo's own transactional log keeps the email
  body**, password included, for anyone with access to the Brevo account.
- **Activity log** records sign-ins, failed/locked sign-ins, and every change (users, roles,
  knowledge answers + sources, ticket status, WhatsApp link/unlink/pair, stats reset). Page views
  are not recorded. The JSON store is capped at 5000 entries; Mongo keeps everything.
- **First Owner:** on a boot with zero accounts, `ADMIN_OWNER_EMAIL` + `ADMIN_OWNER_PASSWORD`
  (falling back to `AURAX_TEAM_PASSWORD`) create it. Without `ADMIN_OWNER_EMAIL` nobody can sign in
  — boot logs a warning. Recovery: `npm run admin-user -- --email … --password …` (creates or
  resets an active Owner and ends its sessions; the running server picks it up within 60s).
- `db.js` honours `AURAX_DATA_DIR`, used only by the test suite to stay off live data. The account
  helpers there **throw** on storage errors instead of silently falling back to JSON — a failed read
  that returned `[]` would look like "no accounts" and re-run Owner seeding.
- The console's `Modal` is portalled to `<body>`: page roots carry the `.fade` transform animation,
  which traps `position:fixed` children (the backdrop covered only the page body).

Verified 2026-09-17: `npm run test-admin-auth` all checks pass; a headless-Chrome run against the
real router covered owner sign-in, creating a tester with a generated password (email payload
matched), the tester seeing only Monitor/WhatsApp/Knowledge/Tickets, `/users` redirecting, WhatsApp
showing no QR or link controls, the no-email credentials notice, and a 390px phone layout with no
page overflow — zero console errors besides the deliberate wrong-password 401.

### Admin Console deployment — Vercel primary, Express fallback (2026-08-02)

The console is deployed to **Vercel** (Root Directory `apps/admin`), and the bot **also** still
serves it at `/admin`. Two targets, and they need different `base` values, which is the whole
reason for the dual build:

| Target | Command | `base` | Output | Committed? |
|---|---|---|---|---|
| Vercel (primary) | `npm run build` | `/` | `apps/admin/dist` | No — Vercel builds it per push |
| Express (fallback) | `npm run build:express` | `/admin/` | `apps/admin/dist-express` | **Yes** — the VPS runs `npm ci --omit=dev` and cannot build |

`build:express` is `vite build --mode express` — Vite's built-in flag, chosen over a
`cross-env ADMIN_TARGET=...` variable so no extra dependency is needed to set it on Windows.

**Three pieces make the split work:**

1. **`apiUrl()` in `api.js`** prefixes every request with `VITE_API_BASE_URL`. Empty (dev and
   the Express build) = same-origin; set (Vercel) = absolute to the bot. `makeApi` routes
   through it, and so must the two raw `fetch` calls that bypass the helper —
   `Login.jsx` (pre-token) and the `Knowledge.jsx` document upload (multipart, which the
   JSON-forcing helper would corrupt). **A bare `fetch('/api/…')` is a bug on Vercel:** it hits
   the Vercel domain, the SPA rewrite returns `index.html`, and the caller dies on
   `Unexpected token '<'`.
2. **`BrowserRouter basename={import.meta.env.BASE_URL}`** in `main.jsx`. `BASE_URL` *is* vite's
   `base`, so the router follows the build target automatically instead of needing a second knob.
3. **CORS in `apps/bot/src/index.js`**, driven by `ADMIN_ALLOWED_ORIGINS`. Deliberately not `*`
   — these endpoints expose sessions, logs and customer conversations. Exact origins, or
   `*.`-prefixed suffix matches for Vercel's per-commit preview hostnames. Preflight is answered
   in the middleware because `OPTIONS` carries no `Authorization` header and would otherwise 401.
   No `Allow-Credentials`: auth is a bearer token, not a cookie.

⚠️ **The two deployments drift.** Vercel rebuilds on push; the Express copy only updates when
someone runs `npm run build-admin` and commits `dist-express`. After changing `apps/admin/src`,
do both or knowingly leave the fallback stale.

Verified live 2026-08-02: both builds emit the correct asset base; against a running bot,
`/admin`, the `/admin/*` SPA deep-link fallback and the hashed assets all 200; preflight from an
exact origin and from a `*.vercel.app` preview both return the allow headers while a
non-allowlisted origin gets none; cross-origin login returns a token and `/api/sessions`,
`/api/provider-stats`, `/api/knowledge`, `/api/knowledge/sources`, `/api/tickets/open-count`
all 200 with it; unauthenticated calls still 401 **with** the CORS header, so the SPA can read
the error rather than seeing an opaque network failure.

### Safe Mode

If `ALLOWED_TEST_NUMBERS` is set, the bot only responds to those phone numbers — useful for staging.

### Monitoring Endpoints

| Route | Description |
|---|---|
| `GET /api/whatsapp/status` | WhatsApp Web connection state + QR code + linked-account info |
| `POST /api/whatsapp/logout` | Unlink the paired phone and bring up a fresh QR (auth required) |
| `POST /api/whatsapp/pair` | Switch to phone-number linking; body `{phoneNumber}` (auth required) |
| `POST /api/whatsapp/pair/cancel` | Leave phone-number linking and go back to the QR (auth required) |
| `POST /api/auth/login` | Console sign-in `{email, password}` → `{token, user}` |
| `GET /api/admin/users` · `GET /api/admin/roles` | Accounts and roles (`users.manage`) |
| `GET /api/admin/activity` | Who changed what (`activity.view`); `?limit=&before=` |
| `GET /api/retry-stats` | Pending retry queue, provider status, active provider |

### Rate-Limit Protection

- **Throttle**: Per-(provider, key) min gap, not just per-provider — each of the 5 Groq keys has its own timer (`AIService.minApiGapMs` / `lastApiCallTimes` keyed by `provider#keyIndex`), so multiple keys give real parallel throughput instead of sharing one timer.
- **Key rotation**: The starting key per provider (`rotateEntries()`) is chosen by hashing the customer's `senderId`, so concurrent requests still spread across keys instead of hammering key[0] — but **one conversation stays pinned to one key**. Prompt caching is per-key: the old global round-robin cursor made consecutive turns of the same conversation alternate keys and hit a cold prefix every time. Measured on a 6-call Tanglish conversation with 2 Sarvam keys: **15% of input cached under round-robin vs 38% under affinity** (83% on a single-key run). ~85% of every request is the byte-identical system prompt + tool schema, and cached input bills at ₹2.5/M vs ₹4/M on Sarvam. Falls back to the round-robin cursor when there's no affinity key (retry-queue replays, background jobs).
- **Retry**: 4 attempts with exponential backoff for 429/500/503 *and* Groq's `tool_use_failed` (malformed tool-call generation, usually transient).
- **Quota**: Daily quota exhaustion is tracked **per key** (`keyExhaustedUntil`), not per provider — one exhausted Groq key no longer benches its sibling keys. Persistent retry queue (DB-backed) survives restarts; entries are only kept alive across a restart if the retry itself re-exhausts quota, otherwise they're always cleared (this used to leak on send failure and replay forever — fixed).
- **Concurrency**: WhatsApp messages are chained **per sender** (not a flat concurrency-N pool) — same customer's messages are processed strictly in order to avoid session read-modify-write races (e.g. "size M" then "qty 3" sent seconds apart used to be able to clobber each other); different customers still run fully in parallel.
- **Message trimming** (`trimMessagesToTokenBudget()` in `ai.js`): char-budget trims the oldest messages when a conversation gets long, but always keeps at least the single most recent message/tool-call-pair regardless of budget — a `tool` result message is only valid immediately after the assistant message that issued its `tool_calls`, so they're trimmed as one atomic group, never split. Without this, a single large `search_products` tool result (full product JSON) could exceed the budget and get dropped along with the user's actual question, leaving the model just the bare system prompt — some models (Qwen) correctly rejected that outright, others (Llama) silently improvised a generic answer with zero real context.

### Language Handling (Tanglish vs English)

Language is detected deterministically in code (`detectLanguage()` in `ai.js`) via Tamil-script/keyword matching — not left to the LLM to guess each turn. It's decided once and locked into `session.language` for the whole conversation. For Tanglish sessions, Gemini is tried before Groq in the fallback chain (noticeably better at natural Tamil-English code-mixing than Llama-3.3); English sessions keep Groq first.

Picking the right language is only half the job — the words also have to be real. See
"Tanglish quality — three defences" for the 2026-09-22 work on invented Tamil word-forms, the
colder sampling temperature Tanglish now uses, and `npm run test-tanglish`.

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

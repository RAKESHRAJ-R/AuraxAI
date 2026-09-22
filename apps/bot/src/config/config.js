import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file (if it exists)
// override: true ensures .env values take precedence over pre-existing shell env vars
dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });

// `.env.local` wins over `.env` when present. It exists so a developer can run the bot on
// their own machine WITHOUT touching production: the real .env points MONGODB_URI at the
// live Atlas cluster and WHATSAPP_CLIENT_ID at the paired shop session, so a plain local
// `npm start` would read and write the production watermark, queue and leads, and try to
// restore the live WhatsApp session onto a second machine (which corrupts it — see the
// two-clients-one-LocalAuth warning in whatsapp-web-bot.js).
//
// Because `.env` is loaded with override:true, exporting a shell variable cannot win
// against it; a file that loads afterwards is the only thing that can. Gitignored via the
// repo's `.env.*` rule.
const localEnv = path.join(__dirname, '../../.env.local');
if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv, override: true });
  console.log('[Config] ⚠️  .env.local is present and OVERRIDES .env — this is a local dev run, not production.');
}

const config = {
  port: process.env.PORT || 3000,
  woocommerce: {
    url: (process.env.WOOCOMMERCE_URL || 'https://theaurax.in').trim(),
    consumerKey: (process.env.WOOCOMMERCE_CONSUMER_KEY || '').trim(),
    consumerSecret: (process.env.WOOCOMMERCE_CONSUMER_SECRET || '').trim(),
    // WordPress Application Password — an ALTERNATIVE credential for the exact same
    // wc/v3 endpoints, used in preference to the consumer key when both are set.
    // Added 2026-09-20: a plugin on theaurax.in intercepts any request carrying a
    // recognised WooCommerce consumer key and answers
    // `{"success":false,"message":"API is working, Site Connected"}` with HTTP 401 —
    // on EVERY REST route, valid secret or not. That killed both product sync and
    // order creation (so customers got a PDF invoice with no payment link). An app
    // password is not a consumer key, so the interceptor ignores it, and it
    // authenticates as a real WP user, which also satisfies the site's
    // "Disable WP REST API" plugin. The user must be Administrator or Shop Manager,
    // otherwise wc/v3 authenticates but then 403s on permissions.
    appUser: (process.env.WOOCOMMERCE_APP_USER || '').trim(),
    // WP prints it in "abcd EFGH ijkl" groups; the spaces are cosmetic but harmless.
    appPassword: (process.env.WOOCOMMERCE_APP_PASSWORD || '').trim(),
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    apiKeys: (process.env.GROQ_API_KEY || '').split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0 && !k.includes('your_groq')),
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    // Qwen3 (free on Groq) handles Tamil-English code-mixing noticeably better than
    // Llama-3.3, but its free tier caps at 8000 TPM/key — 5 keys = 40,000 TPM total for
    // the WHOLE bot's Tanglish traffic combined. Verified live: a single solo test
    // conversation exhausted 2 of 5 keys' entire daily quota and took 5-6 minutes on one
    // turn. Not viable for concurrent real customers — off by default. Only set
    // GROQ_TANGLISH_MODEL explicitly if you've upgraded to Groq's paid Dev Tier.
    tanglishModel: process.env.GROQ_TANGLISH_MODEL || null,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    apiKeys: (process.env.OPENAI_API_KEY || '').split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0 && !k.includes('your_openai')),
  },
  // Knowledge-source semantic search. `local` (default) runs all-MiniLM-L6-v2 on CPU via
  // @huggingface/transformers — no key, no quota, no per-call cost, and nothing leaves the
  // server. `openai` uses text-embedding-3-small and needs a funded OPENAI_API_KEY.
  // Switching providers changes the vector width, so existing sources must be re-indexed.
  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER || 'local').toLowerCase(),
    // Where the ONNX model is cached. Must be writable by the user the app runs as —
    // the library's default lives inside node_modules, which is root-owned on a
    // `npm ci` deploy while the service runs as an unprivileged user.
    cacheDir: process.env.EMBEDDING_CACHE_DIR || './.models',
    // Preload the model at boot so the first customer question doesn't pay the ~1-4s
    // load. Skipped automatically when no knowledge sources are indexed.
    warmup: process.env.EMBEDDING_WARMUP !== 'false',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    apiKeys: (process.env.GEMINI_API_KEY || '').split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0 && !k.includes('your_gemini')),
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    apiKeys: (process.env.OPENROUTER_API_KEY || '').split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0),
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  },
  fireworks: {
    // Paid provider (client-supplied key). OpenAI-compatible API. Confirmed working
    // for tool-calling. deepseek-v4-pro gives noticeably better English discipline and
    // natural Tanglish code-mixing than Llama-3.3 — used Tanglish-first (Gemini's old
    // Tanglish slot is dead: free tier returns limit:0) and as an English paid fallback.
    apiKey: process.env.FIREWORKS_API_KEY || '',
    apiKeys: (process.env.FIREWORKS_API_KEY || '').split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0 && !k.includes('your_fireworks')),
    // ⚠️ The un-dated 'deepseek-v4-pro' was a preview that Fireworks DEPRECATED on
    // 2026-08-27 (model record: supportsServerless:false). It still appears in
    // GET /v1/models but every completion returns 404 "Model not found, inaccessible,
    // and/or not deployed" — so Fireworks silently failed on every call and traffic fell
    // through to Sarvam. '-0813' is the official release that superseded it (verified
    // live 2026-09-17: tool-calling + Tanglish OK). Dated ids get retired too — if
    // Fireworks starts 404ing again, check the model's deprecationDate first.
    model: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4-pro-0813',
  },
  sarvam: {
    // Indic-specialised provider (Sarvam AI, Indian). OpenAI-compatible endpoint
    // (baseURL https://api.sarvam.ai/v1, Authorization: Bearer). Sarvam's models are
    // purpose-trained on romanized AND code-mixed Indian-language text (Tamil incl.),
    // so this is the Tanglish-first provider — better code-mixing than Llama-3.3.
    // Full OpenAI-style tool calling confirmed. Gated behind SARVAM_API_KEY — absent =
    // provider simply isn't loaded, no behavior change.
    //
    // ⚠️ sarvam-30b (the original default) was DEPRECATED by Sarvam in June 2026 and is
    // now GONE from the API — GET /v1/models lists only sarvam-105b, and a completion
    // with model 'sarvam-30b' returns HTTP 400 (verified live 2026-08-04). The vendor's
    // documented migration target is sarvam-105b (128K ctx), which is what this now
    // defaults to. Do NOT set SARVAM_MODEL back to a 30b/16k variant — they are retired.
    apiKey: process.env.SARVAM_API_KEY || '',
    apiKeys: (process.env.SARVAM_API_KEY || '').split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0 && !k.includes('your_sarvam')),
    model: process.env.SARVAM_MODEL || 'sarvam-105b',
  },
  whatsapp: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  },
  instagram: {
    pageAccessToken: process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || '',
    verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN || 'theaurax_verify_token_2026',
  },
  owner: {
    whatsappNumber: process.env.OWNER_WHATSAPP_NUMBER || '',
    instagramId: process.env.OWNER_INSTAGRAM_ID || '',
    bulkThreshold: parseInt(process.env.BULK_ORDER_THRESHOLD || '20', 10),
  },
  // Customer-support contact details surfaced by the after-sales / support agent.
  // These are the real Theaurax channels the bot hands out (and the humans a ticket
  // routes to). Overridable via env, with sensible hard-coded defaults so the feature
  // works out of the box without extra config.
  support: {
    email: (process.env.SUPPORT_EMAIL || 'support@theaurax.in').trim(),
    wholesaleNumber: (process.env.WHOLESALE_NUMBER || '9884442049').replace(/[^0-9]/g, ''),
  },
  // What the store actually accepts. The bot's payment answers are built from THIS, never
  // from the model's imagination — so a method only reaches a customer if it is listed here.
  // Defaults mirror the live store: Razorpay is the only gateway, COD is disabled.
  payment: {
    codEnabled: String(process.env.PAYMENT_COD_ENABLED || 'false').toLowerCase() === 'true',
    gateway: (process.env.PAYMENT_GATEWAY || 'Razorpay').trim(),
    methods: (process.env.PAYMENT_METHODS || 'UPI,Debit/Credit card,Net banking')
      .split(',').map(s => s.trim()).filter(Boolean),
  },
  wati: {
    endpoint: process.env.WATI_API_ENDPOINT || '',
    accessToken: process.env.WATI_ACCESS_TOKEN || '',
    allowedTestNumbers: (process.env.ALLOWED_TEST_NUMBERS || '')
      .split(',')
      .map(num => num.replace(/[^0-9]/g, ''))
      .filter(num => num.length > 0)
  },
  whatsappWeb: {
    enabled: process.env.WHATSAPP_WEB_ENABLED === 'true',
    // Browser identity reported to WhatsApp. Empty = derived from the Chrome build Puppeteer
    // actually runs (see whatsapp-web-bot.js). Only set this to pin a specific string.
    userAgent: process.env.WHATSAPP_USER_AGENT || null,
    // Session folder name under .wwebjs_auth/. Change it for local testing so a dev
    // machine pairs a throwaway number instead of restoring the live shop session.
    clientId: process.env.WHATSAPP_CLIENT_ID || 'theaurax-bot',
    // --- Outbound send pacing (WhatsApp ban-risk protection) ---
    // whatsapp-web.js is an UNOFFICIAL client: WhatsApp bans numbers that behave like
    // bots, and the loudest signal is a burst of instant, evenly-spaced replies to many
    // different people at once (exactly what a reel drop produces). Every outbound
    // message in the app funnels through whatsappWebBot.sendText(), which serialises
    // sends and enforces these limits globally — per ACCOUNT, not per chat, because
    // that's how WhatsApp measures it.
    // Defaults are deliberately conservative; raise only with evidence.
    // Lowered from 1200/900/30 on 2026-09-17 after the live number was restricted for
    // "spam, automated or bulk messaging". 30/min is a fast human INSIDE ONE CHAT; across
    // 30 DIFFERENT chats it is a broadcast, which is the thing WhatsApp actually measures.
    minSendGapMs: parseInt(process.env.WA_MIN_SEND_GAP_MS || '4000', 10),
    // Random extra 0..N ms on top of the gap so the spacing isn't machine-perfect.
    sendJitterMs: parseInt(process.env.WA_SEND_JITTER_MS || '3000', 10),
    // Hard ceiling over a rolling 60s window.
    maxSendsPerMinute: parseInt(process.env.WA_MAX_SENDS_PER_MIN || '8', 10),
    // Hard ceiling over a rolling 60 MINUTE window, counted only over DISTINCT chats.
    // The per-minute cap alone cannot stop a slow, steady 480-chats-per-hour broadcast,
    // which is precisely what a large catch-up backlog looks like from WhatsApp's side.
    maxNewChatsPerHour: parseInt(process.env.WA_MAX_NEW_CHATS_PER_HOUR || '30', 10),
    // Minimum time between receiving a message and replying to it. Deterministic
    // fast-path replies (FAQ / knowledge / size-parse) return in ~0ms, which reads as
    // inhuman; this pads them. Replies that already took longer (LLM calls) are NOT
    // delayed further — see humanizeDelay().
    minReplyDelayMs: parseInt(process.env.WA_MIN_REPLY_DELAY_MS || '1400', 10),
    // Extra think-time scaled by reply length (ms per character), capped below.
    replyDelayPerCharMs: parseFloat(process.env.WA_REPLY_DELAY_PER_CHAR_MS || '12'),
    maxReplyDelayMs: parseInt(process.env.WA_MAX_REPLY_DELAY_MS || '4000', 10),
  },
  // --- Missed-message catch-up ---
  // whatsapp-web.js only emits 'message' for messages that arrive LIVE while the client is
  // connected (Client.js guards every emit with `if (!msg.isNewMsg) return`). Anything that
  // was already on the phone when we paired, or that arrived while the server was down, is
  // loaded as history and never fires an event — so without this sweep those customers are
  // silently never answered. The requirement is that NOTHING is missed, so the sweep queues
  // every unanswered chat and drains it at a deliberately slow rate: replying to a large
  // backlog at full speed is exactly the pattern that gets an unofficial client banned.
  catchup: {
    enabled: process.env.CATCHUP_ENABLED !== 'false',
    // Tier 1. A customer who wrote within this window is still actively waiting, so their
    // reply goes out immediately at normal pace on reconnect.
    freshHours: parseInt(process.env.CATCHUP_FRESH_HOURS || '12', 10),
    // How many tier-1 items may be answered back-to-back at the end of a sweep. Everything
    // beyond this goes into the same slow drip as tier 2.
    //
    // Added 2026-09-17. Before this, drainFresh() answered EVERY tier-1 item in one
    // uninterrupted loop, bounded only by the per-minute send cap — so pairing a phone that
    // had 60 unread chats from the last 12h produced 60 first-contact messages in ~2 minutes.
    // That is what got the live number restricted for bulk messaging.
    freshMaxImmediate: parseInt(process.env.CATCHUP_FRESH_MAX_IMMEDIATE || '5', 10),
    // The FIRST sweep on a number with no watermark (a freshly paired phone, or a wiped
    // data dir) would otherwise treat the account's ENTIRE history as "missed" — 600+ chats
    // on the live account. Nobody wants a bot answering a chat from last March on the day
    // it is switched on. With no watermark, only look back this far. 0 disables the guard
    // and restores the old answer-everything behaviour.
    coldStartHours: parseInt(process.env.CATCHUP_COLD_START_HOURS || '24', 10),
    // Tier 2. Everything older is still answered, just dripped out. 0 = no age limit at all
    // (handle the entire backlog however far back it goes) — no longer the default, because
    // an unprompted reply to a months-old chat reads as outreach, not as a reply.
    maxAgeDays: parseInt(process.env.CATCHUP_MAX_AGE_DAYS || '2', 10),
    // Drip rate for tier 2, per hour. Lowered from 120 on 2026-09-17: 120/h is still 2,880
    // unsolicited-looking messages a day from one handset, and the live number was
    // restricted at roughly that pace. 20/h clears a 500-chat backlog in about a day.
    drainPerHour: parseInt(process.env.CATCHUP_DRAIN_PER_HOUR || '20', 10),
    // How many tier-2 items may go out in a single tick, so the drip isn't perfectly periodic.
    drainBatch: parseInt(process.env.CATCHUP_DRAIN_BATCH || '2', 10),
    tickMs: parseInt(process.env.CATCHUP_TICK_MS || '60000', 10),
    // Hard ceiling on how many chats one sweep will look at, so a pathological account
    // can't hang the boot sequence.
    maxChatsScanned: parseInt(process.env.CATCHUP_MAX_CHATS_SCANNED || '5000', 10),
    // Tell the owner on WhatsApp when a sweep finds missed customers, and again when the
    // backlog finishes draining.
    alertOwner: process.env.CATCHUP_ALERT_OWNER !== 'false',
    // Sweep and report, but send NOTHING and queue nothing. The safe way to see what a
    // catch-up would do on a real account before letting it message anybody — and the only
    // way to verify the sweep against live customer data without contacting them.
    dryRun: process.env.CATCHUP_DRY_RUN === 'true',
  },
  // Cold-lead re-engagement. This is the ONLY path in the app that contacts a customer who
  // did not just message us, which makes it the highest ban-risk feature we ship — it is
  // literally "starting new chats", the exact capability WhatsApp revokes first when it
  // flags an account. Kept behind a switch so it can be turned off without a deploy.
  followUp: {
    enabled: process.env.FOLLOWUP_ENABLED !== 'false',
    inactiveHours: parseInt(process.env.FOLLOWUP_INACTIVE_HOURS || '3', 10),
    maxPerLead: parseInt(process.env.FOLLOWUP_MAX_PER_LEAD || '2', 10),
    // Minimum gap between two follow-ups to the SAME person. Without this the second
    // nudge lands on the very next 30-minute run: eligibility is measured from the
    // customer's last message (`updatedAt`), and our own follow-up does not move it, so
    // an already-overdue lead stays overdue the instant follow-up #1 is sent. From the
    // customer's side that is two near-identical "still interested?" texts half an hour
    // apart — the pattern that reads as a bot on a loop.
    cooldownHours: parseInt(process.env.FOLLOWUP_COOLDOWN_HOURS || '24', 10),
    // Never re-engage a lead whose last real activity is older than this. `updatedAt` from
    // months ago is not a warm lead, and an unprompted message into a long-dead chat is
    // outreach, not a follow-up — the same reasoning as catchup.maxAgeDays. It also matters
    // on a freshly paired phone: without it, every stale lead in the database becomes
    // eligible the moment the bot connects. 0 disables the guard.
    maxLeadAgeDays: parseInt(process.env.FOLLOWUP_MAX_LEAD_AGE_DAYS || '3', 10),
    // Hard cap per 30-minute run. Without it the loop walks EVERY active lead in one pass,
    // sending near-identical templated text to all of them — the textbook bulk pattern.
    maxPerRun: parseInt(process.env.FOLLOWUP_MAX_PER_RUN || '8', 10),
  },
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  // Admin console accounts. Every person signs in with their own email + password and
  // gets a role that decides which pages they can open (services/adminAuth.js).
  //
  // The owner settings below are used exactly ONCE: on a boot where no accounts exist yet,
  // they create the first Owner. After that they are ignored — change passwords from the
  // Users page, or recover a lost Owner login with `npm run admin-user`.
  adminAuth: {
    ownerEmail: (process.env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase(),
    ownerName: (process.env.ADMIN_OWNER_NAME || 'Store Owner').trim(),
    // Falls back to the old shared Aurax team password so an existing deployment only
    // needs ADMIN_OWNER_EMAIL added to come up with a working owner login.
    ownerPassword: process.env.ADMIN_OWNER_PASSWORD || process.env.AURAX_TEAM_PASSWORD || process.env.KNOWLEDGE_HUB_PASSWORD || '',
    sessionTtlHours: parseInt(process.env.ADMIN_SESSION_TTL_HOURS || '168', 10),
  },
  // Retired shared-password logins. Read only so boot can warn that they no longer work.
  legacyAdminPasswords: {
    testing: process.env.TESTING_TEAM_PASSWORD || '',
    knowledgeHub: process.env.KNOWLEDGE_HUB_PASSWORD || '',
  },
  // Transactional email via Brevo — sends new staff their login details. Optional: without
  // it accounts still work, the owner just shares the details by hand. The sender address
  // must be verified in Brevo (Senders & IP → Senders), and the domain authenticated
  // (SPF/DKIM) or the email lands in spam.
  mail: {
    brevoApiKey: (process.env.BREVO_API_KEY || '').trim(),
    fromEmail: (process.env.MAIL_FROM_EMAIL || '').trim(),
    fromName: (process.env.MAIL_FROM_NAME || 'Aurax Admin').trim(),
  },
  // Public URL of the admin console, used as the sign-in link in those emails. Normally the
  // Vercel URL. Falls back to the self-hosted /admin build on this server.
  adminConsoleUrl: (process.env.ADMIN_CONSOLE_URL || '').trim().replace(/\/+$/, ''),
  // Origins allowed to call the admin API cross-origin. The console is deployed to
  // Vercel, which is a different origin than this server, so its URL must be listed
  // here or the browser blocks every response. Comma-separated, exact origins only
  // (scheme + host + optional port, no path, no trailing slash) — e.g.
  //   https://aurax-admin.vercel.app,https://admin.theaurax.in
  // Empty = no cross-origin access at all; only the self-hosted /admin build works.
  adminAllowedOrigins: (process.env.ADMIN_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
};

// Basic validation
export const validateConfig = () => {
  const missing = [];
  if (!config.woocommerce.consumerKey) missing.push('WOOCOMMERCE_CONSUMER_KEY');
  if (!config.woocommerce.consumerSecret) missing.push('WOOCOMMERCE_CONSUMER_SECRET');
  if (!config.groq.apiKey) missing.push('GROQ_API_KEY');

  if (missing.length > 0) {
    console.warn(`[WARNING] Missing environment variables: ${missing.join(', ')}`);
    console.warn('[WARNING] Some features might not work correctly until these are set in a .env file.');
    return false;
  }
  return true;
};

export default config;

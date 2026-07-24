import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file (if it exists)
// override: true ensures .env values take precedence over pre-existing shell env vars
dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });

const config = {
  port: process.env.PORT || 3000,
  woocommerce: {
    url: (process.env.WOOCOMMERCE_URL || 'https://theaurax.in').trim(),
    consumerKey: (process.env.WOOCOMMERCE_CONSUMER_KEY || '').trim(),
    consumerSecret: (process.env.WOOCOMMERCE_CONSUMER_SECRET || '').trim(),
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
    model: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4-pro',
  },
  sarvam: {
    // Indic-specialised provider (Sarvam AI, Indian). OpenAI-compatible endpoint
    // (baseURL https://api.sarvam.ai/v1, Authorization: Bearer). sarvam-30b/105b are
    // purpose-trained on romanized AND code-mixed Indian-language text (Tamil incl.),
    // so this is the Tanglish-first provider — better code-mixing than Llama-3.3 and
    // cheaper than Fireworks (~₹360/mo at 100 convos/day; ₹1,000 signup credit covers
    // ~12,000 convos). Full OpenAI-style tool calling confirmed. Gated behind
    // SARVAM_API_KEY — absent = provider simply isn't loaded, no behavior change.
    apiKey: process.env.SARVAM_API_KEY || '',
    apiKeys: (process.env.SARVAM_API_KEY || '').split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0 && !k.includes('your_sarvam')),
    model: process.env.SARVAM_MODEL || 'sarvam-30b',
  },
  whatsapp: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
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
  },
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  knowledgeHub: {
    // Single shared password protecting the /knowledge-hub admin page + its APIs.
    // If unset, the hub APIs refuse all logins (page is inert) — set it to enable.
    // Kept as a backward-compatible fallback that logs in as the Aurax team.
    password: process.env.KNOWLEDGE_HUB_PASSWORD || '',
  },
  // Team-scoped admin logins: one shared password per team. Whichever password
  // is entered decides which team the session is tagged with. Both grant the same
  // access today — the team tag is for attribution, not different permissions.
  adminTeams: {
    auraxPassword: process.env.AURAX_TEAM_PASSWORD || '',
    testingPassword: process.env.TESTING_TEAM_PASSWORD || '',
  },
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

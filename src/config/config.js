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

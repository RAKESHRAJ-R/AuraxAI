import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file (if it exists)
dotenv.config({ path: path.join(__dirname, '../../.env') });

const config = {
  port: process.env.PORT || 3000,
  woocommerce: {
    url: process.env.WOOCOMMERCE_URL || 'https://theaurax.in',
    consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY || '',
    consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET || '',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
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
};

// Basic validation
export const validateConfig = () => {
  const missing = [];
  if (!config.woocommerce.consumerKey) missing.push('WOOCOMMERCE_CONSUMER_KEY');
  if (!config.woocommerce.consumerSecret) missing.push('WOOCOMMERCE_CONSUMER_SECRET');
  if (!config.openai.apiKey && !config.gemini.apiKey) {
    missing.push('OPENAI_API_KEY (or GEMINI_API_KEY)');
  }

  if (missing.length > 0) {
    console.warn(`[WARNING] Missing environment variables: ${missing.join(', ')}`);
    console.warn('[WARNING] Some features might not work correctly until these are set in a .env file.');
    return false;
  }
  return true;
};

export default config;

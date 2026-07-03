import telegramService from './services/telegram.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testTelegramAlert() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  console.log('Sending test Telegram alert...');
  
  if (!token || !chatId) {
    console.warn('\n⚠️  WARNING: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in your .env file.');
    console.warn('The service will run in MOCK Mode and will NOT send a real message to Telegram.\n');
  }

  const success = await telegramService.sendAlert(
    '🚨 <b>Theaurax Sales Bot Live Test</b> 🚨\n\nThis is a test notification verifying your Telegram Bot alert setup works correctly!'
  );
  
  if (success) {
    console.log('✅ Telegram alert processed.');
  } else {
    console.log('❌ Failed to process Telegram alert.');
  }
}

testTelegramAlert();

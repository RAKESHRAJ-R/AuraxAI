import whatsappService from './services/whatsapp.js';
import { validateConfig } from './config/config.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testAlert() {
  validateConfig();

  const recipient = process.env.OWNER_WHATSAPP_NUMBER || '+919940954744';
  const message = '🚨 *Theaurax AI Assistant Alert* 🚨\n\nThis is a live test message sent to verify that your Meta WhatsApp Cloud API integration is working correctly!';

  console.log(`Sending alert message to: ${recipient}`);
  
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.warn('\n⚠️  WARNING: WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is missing in your .env file.');
    console.warn('The service will run in MOCK Mode and will NOT send a real message to your phone.\n');
  }

  const success = await whatsappService.sendTextMessage(recipient, message);
  
  if (success) {
    console.log('✅ Send action processed.');
  } else {
    console.log('❌ Failed to process send action.');
  }
}

testAlert();

import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = `http://localhost:${PORT}/webhook`;

async function testWatiWebhook() {
  console.log('🏁 Starting WATI webhook local test...');

  // 1. Simulating message from a non-allowed number (e.g. 919999999999)
  console.log('\n--- Test 1: Non-Allowed Number (Real Customer) ---');
  try {
    const res = await axios.post(WEBHOOK_URL, {
      eventType: 'messageReceived',
      senderNumber: '919999999999',
      text: 'Do you have Real Madrid jerseys?',
      whatsappNumber: '919999999999',
      messageType: 'text'
    });
    console.log(`Status code: ${res.status} | Response: "${res.data}"`);
    console.log('Expectation: Server should log safe-mode ignore and return EVENT_RECEIVED immediately.');
  } catch (err) {
    console.error('Test 1 failed:', err.message);
  }

  // 2. Simulating message from an allowed test number
  // Fallback to owner number if allowed list is not yet populated
  const rawNum = process.env.ALLOWED_TEST_NUMBERS || process.env.OWNER_WHATSAPP_NUMBER || '916381463321';
  const testNumber = rawNum.split(',')[0].replace(/[^0-9]/g, '');

  console.log(`\n--- Test 2: Allowed Test Number (${testNumber}) ---`);
  try {
    const res = await axios.post(WEBHOOK_URL, {
      eventType: 'messageReceived',
      senderNumber: testNumber,
      text: 'What is the cheapest adult jersey?',
      whatsappNumber: testNumber,
      messageType: 'text'
    });
    console.log(`Status code: ${res.status} | Response: "${res.data}"`);
    console.log('Expectation: Server should print "New WATI Message Received", run AI, and attempt send.');
  } catch (err) {
    console.error('Test 2 failed:', err.message);
  }
}

testWatiWebhook();

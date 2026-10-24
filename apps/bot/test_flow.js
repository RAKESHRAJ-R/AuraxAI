import config from './src/config/config.js';
import aiService from './src/services/ai.js';
import dbService from './src/services/db.js';

async function test() {
  const senderId = 'customer_test_101';
  await dbService.saveSession(senderId, { history: [], cart: [], address: null, state: 'IDLE' });
  
  console.log("--- TEST START ---");
  const r1 = await aiService.answerQuery(senderId, "I want to place an order for ARGENTINA 2006 HOME — MESSI");
  console.log("R1:", r1.replyText);

  const r2 = await aiService.answerQuery(senderId, "Size M 50 pieces");
  console.log("R2:", r2.replyText);
  
  const r3 = await aiService.answerQuery(senderId, "Alice, 636004, 1234567890");
  console.log("R3:", r3.replyText);

  const r4 = await aiService.answerQuery(senderId, "True");
  console.log("R4:", r4.replyText);

  console.log("--- TEST END ---");
}

test().catch(console.error);

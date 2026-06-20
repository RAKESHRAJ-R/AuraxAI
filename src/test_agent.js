import aiService from './services/ai.js';
import { validateConfig } from './config/config.js';
import dbService from './services/db.js';

// Pre-configured static queries for single-turn baseline verification
const SINGLE_TURN_TESTS = [
  "Do you have Real Madrid jerseys?",
  "What is the shipping time to Delhi?",
  "Do you support cash on delivery (COD)?",
];

// Multi-turn order process simulation
const SIMULATED_CUSTOMER_FLOW = [
  { senderId: 'customer_sim_99', message: "I want to buy the Arsenal Home 26/27 jersey." },
  { senderId: 'customer_sim_99', message: "size XXL" },
  { senderId: 'customer_sim_99', message: "2 pieces" },
  { senderId: 'customer_sim_99', message: "My address is: Alice Smith, Flat 401, Sapphire Heights, Mumbai 400053, Ph: 9819928374" },
  { senderId: 'customer_sim_99', message: "YES" },
  { senderId: 'customer_sim_99', message: "What is your return policy?" } // test that they are back in IDLE FAQ mode
];

async function runSingleTurnTest(query) {
  const dummySenderId = `test_user_single_${Math.floor(Math.random() * 1000)}`;
  console.log('\n' + '='.repeat(60));
  console.log(`💬 CUSTOMER: "${query}"`);
  console.log('='.repeat(60));

  try {
    const response = await aiService.answerQuery(dummySenderId, query);
    
    console.log(`🤖 AI AGENT REPLY:`);
    console.log('-'.repeat(60));
    console.log(response.replyText);
    console.log('-'.repeat(60));
    
    console.log(`⚙️  METADATA:`);
    console.log(`   - Intent:           ${response.intent.toUpperCase()}`);
    console.log(`   - Owner Escalation: ${response.requiresEscalation ? '⚠️ YES' : '✅ No'}`);
    console.log(`   - Matched Products: ${response.suggestedProductIds.length > 0 ? response.suggestedProductIds.join(', ') : 'None'}`);
    
    // Clean up temporary session
    await dbService.clearSession(dummySenderId);
  } catch (error) {
    console.error('❌ Error executing agent test:', error);
  }
}

async function runMultiTurnFlow() {
  console.log('\n' + '#'.repeat(60));
  console.log('🏁 STARTING STATEFUL MULTI-TURN SALES FUNNEL SIMULATION');
  console.log('#'.repeat(60));

  for (const step of SIMULATED_CUSTOMER_FLOW) {
    console.log('\n' + '='.repeat(60));
    console.log(`💬 CUSTOMER (${step.senderId}): "${step.message}"`);
    console.log('='.repeat(60));

    try {
      // Fetch session state BEFORE processing
      const preSession = await dbService.getSession(step.senderId);
      console.log(`[Before Message] State: ${preSession.state} | Cart Items: ${preSession.cart.length}`);

      // Process message
      const response = await aiService.answerQuery(step.senderId, step.message);

      console.log(`🤖 AI AGENT REPLY:`);
      console.log('-'.repeat(60));
      console.log(response.replyText);
      console.log('-'.repeat(60));

      // Fetch session state AFTER processing
      const postSession = await dbService.getSession(step.senderId);
      console.log(`[After Message]  State: ${postSession.state} | Cart Items: ${postSession.cart.length}`);
      if (postSession.address) console.log(`                 Address Saved: "${postSession.address}"`);

    } catch (error) {
      console.error('❌ Error in flow step:', error);
    }
    
    // Pause to avoid triggering Gemini API rate limits (RPM) during test runs
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  // Clean up
  await dbService.clearSession('customer_sim_99');
  console.log('\n' + '#'.repeat(60));
  console.log('✅ MULTI-TURN SIMULATION COMPLETED');
  console.log('#'.repeat(60) + '\n');
}

async function main() {
  validateConfig();

  const userArgs = process.argv.slice(2);
  if (userArgs.length > 0) {
    // Run custom ad-hoc query
    const query = userArgs.join(' ');
    await runSingleTurnTest(query);
  } else {
    console.log('📦 Running Baseline Single-Turn Q&A Tests...');
    for (const query of SINGLE_TURN_TESTS) {
      await runSingleTurnTest(query);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Run the multi-turn flow simulation
    await runMultiTurnFlow();
  }
}

main();

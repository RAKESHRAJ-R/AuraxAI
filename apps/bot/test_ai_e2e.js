import aiService from './src/services/ai.js';
import dbService from './src/services/db.js';
import { validateConfig } from './src/config/config.js';

// Key queries to test the product search end-to-end through the AI agent
const TEST_CASES = [
  // --- Product search queries ---
  { label: 'Real Madrid jerseys',         query: 'Do you have Real Madrid jerseys?' },
  { label: 'Barcelona jerseys',           query: 'Are Barcelona jerseys available?' },
  { label: 'Netherlands jersey (fix!)',   query: 'Do you have Netherlands jerseys?' },
  { label: 'Brazil jersey (spelling)',    query: 'Do you have Brazil jersey?' },
  { label: 'Ronaldo jersey',              query: 'Do you have Ronaldo jersey?' },
  { label: 'Messi jersey',                query: 'Messi jersey iruka bro?' },
  { label: 'Arsenal jersey',              query: 'I want Arsenal jersey' },
  { label: 'Budget under 500',            query: 'Show me jerseys under 500' },
  { label: 'Liverpool jersey',            query: 'Do you have Liverpool jerseys?' },
  { label: 'Bayern Munich jersey (fix!)', query: 'Do you have Bayern Munich jersey?' },
  { label: 'Chelsea jersey',              query: 'I need Chelsea jersey' },
  { label: 'PSG jersey',                  query: 'PSG jersey available?' },
];

async function runTest(query, label) {
  const senderId = `e2e_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  console.log('\n' + '='.repeat(70));
  console.log(`🔍 [${label}]`);
  console.log(`💬 Query: "${query}"`);
  console.log('='.repeat(70));

  try {
    const start = Date.now();
    const response = await aiService.answerQuery(senderId, query);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`⏱️  Response time: ${elapsed}s`);
    console.log(`🤖 Reply:`);
    console.log('-'.repeat(60));
    console.log(response.replyText);
    console.log('-'.repeat(60));
    console.log(`📊 Intent: ${response.intent}`);
    
    // Check if response contains product info (prices, sizes, links)
    const hasProductInfo = /₹\d|price|sizes?|permalink|checkout|buy/i.test(response.replyText);
    const hasWebsiteLink = /theaurax\.in/i.test(response.replyText);
    const hasFallback = /unable|sorry|trouble|couldn't|undergoing maintenance/i.test(response.replyText);
    
    let status;
    if (hasFallback) {
      status = 'failed';
      console.log(`❌ RESULT: FAILED - Got error/fallback message`);
    } else if (hasProductInfo) {
      status = 'passed';
      console.log(`✅ RESULT: PASSED - Contains product details (prices/sizes/links)`);
    } else if (hasWebsiteLink) {
      status = 'partial';
      console.log(`⚠️ RESULT: PARTIAL - Has website link but no direct product details`);
    } else {
      status = 'partial';
      console.log(`⚠️ RESULT: AMBIGUOUS - No clear product info or error`);
    }

    await dbService.clearSession(senderId);
    return status;
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return 'error';
  }
}

async function main() {
  validateConfig();
  console.log('#'.repeat(70));
  console.log('🏟️  THEAURX AI AGENT - END-TO-END PRODUCT SEARCH TEST');
  console.log('#'.repeat(70));
  console.log(`\n📋 ${TEST_CASES.length} test cases to run (with 5s gap between each)...\n`);

  let passed = 0;
  let failed = 0;
  let partial = 0;

  for (const test of TEST_CASES) {
    const status = await runTest(test.query, test.label);
    if (status === 'passed') passed++;
    else if (status === 'partial') partial++;
    else if (status === 'failed' || status === 'error') failed++;
    // Small delay between tests
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('\n' + '#'.repeat(70));
  console.log('📊 SUMMARY');
  console.log('#'.repeat(70));
  console.log(`   Total: ${TEST_CASES.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ⚠️  Partial: ${partial}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log('\n✅ E2E test complete');
}

main().catch(console.error);

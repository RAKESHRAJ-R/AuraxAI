import dbService from './services/db.js';

/**
 * Semi-automated conversation review (see CLAUDE.md "Improving the bot from real
 * conversation failures over time"). Flags likely-problem conversations so a human only
 * needs to read the flagged handful, not every conversation. Deciding the actual fix
 * (system prompt / FAQ / product alias / guardrail edit) stays a manual step — this
 * script only surfaces candidates, it doesn't change anything.
 */

const FALLBACK_PATTERNS = [
  /sorry,?\s*i couldn't process that/i,
  /undergoing maintenance/i,
  /getting (a lot of|tons of) messages/i,
  /could you tell me again what you're looking for/i,
  /couldn't find that exact jersey/i,
  /trouble (processing|understanding)/i,
];

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function findRepeatedQuestions(conversation) {
  const userMsgs = conversation.filter(m => m.role === 'user').map(m => normalize(m.content));
  const counts = {};
  for (const msg of userMsgs) {
    if (msg.length < 4) continue; // skip trivial "hi"/"ok"
    counts[msg] = (counts[msg] || 0) + 1;
  }
  return Object.entries(counts).filter(([, count]) => count >= 2).map(([msg, count]) => ({ msg, count }));
}

function findFallbackHits(conversation) {
  return conversation
    .filter(m => m.role === 'assistant')
    .filter(m => FALLBACK_PATTERNS.some(re => re.test(m.content || '')))
    .map(m => m.content);
}

async function reviewConversations() {
  const leads = await dbService.getAllLeads();
  console.log(`\n[Conversation Review] Scanning ${leads.length} conversations...\n`);

  const flagged = [];

  for (const lead of leads) {
    const conversation = lead.conversation || [];
    if (conversation.length === 0) continue;

    const reasons = [];

    const fallbackHits = findFallbackHits(conversation);
    if (fallbackHits.length > 0) {
      reasons.push(`fallback/error message appeared (${fallbackHits.length}x)`);
    }

    const repeated = findRepeatedQuestions(conversation);
    if (repeated.length > 0) {
      reasons.push(`customer repeated: ${repeated.map(r => `"${r.msg}" x${r.count}`).join(', ')}`);
    }

    // Abandoned mid-purchase: got as far as a cart or address but never completed.
    const abandonedMidPurchase = lead.status !== 'completed'
      && ((lead.cart && lead.cart.length > 0) || lead.address);
    if (abandonedMidPurchase) {
      reasons.push('abandoned mid-purchase (had cart/address but never confirmed)');
    }

    if (reasons.length > 0) {
      flagged.push({ lead, reasons, fallbackHits, conversation });
    }
  }

  if (flagged.length === 0) {
    console.log('No flagged conversations. Nothing looks obviously broken right now.');
    return;
  }

  console.log(`Flagged ${flagged.length} of ${leads.length} conversations:\n`);
  console.log('='.repeat(70));

  for (const { lead, reasons, conversation } of flagged) {
    console.log(`\n📋 ${lead.name || 'Unknown'} (${lead.phone || lead.userId})`);
    console.log(`   Status: ${lead.status} | Updated: ${lead.updatedAt}`);
    for (const reason of reasons) {
      console.log(`   ⚠️  ${reason}`);
    }
    console.log('   --- Last few turns ---');
    for (const msg of conversation.slice(-4)) {
      const preview = (msg.content || '').replace(/\n/g, ' ').slice(0, 100);
      console.log(`   ${msg.role === 'user' ? '👤' : '🤖'} ${preview}${preview.length >= 100 ? '…' : ''}`);
    }
    console.log('-'.repeat(70));
  }

  console.log(`\n${flagged.length} conversation(s) flagged for review out of ${leads.length} total.`);
  console.log('Next step: read the flagged handful above and patch the system prompt/FAQ/product aliases/guardrails based on what you find — not model retraining.\n');
}

reviewConversations().catch(err => {
  console.error('[Conversation Review] Failed:', err);
  process.exit(1);
});

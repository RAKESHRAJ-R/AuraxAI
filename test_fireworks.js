// Standalone Fireworks AI smoke test — verifies the client's key works for THIS bot's needs.
// Run:  node test_fireworks.js
//
// Checks, in order:
//   1. Auth + list which models the account can actually call
//   2. A plain chat completion (basic reply quality + latency)
//   3. Function/tool-calling (your agentic loop in ai.js REQUIRES this)
//   4. A quick Tanglish reply (the documented quality gap)
//
// It does NOT touch ai.js or your live bot. Pure read-only probe.

import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const KEY = (process.env.FIREWORKS_API_KEY || '').trim();
if (!KEY) {
  console.error('❌ No FIREWORKS_API_KEY found in .env. Add:  FIREWORKS_API_KEY=fw_...');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: KEY,
  baseURL: 'https://api.fireworks.ai/inference/v1',
});

// Candidate serverless models to try (first that works wins for the chat tests).
// Confirmed available on this account: gpt-oss-120b, deepseek-v4-pro.
const CANDIDATES = [
  'accounts/fireworks/models/gpt-oss-120b',
  'accounts/fireworks/models/deepseek-v4-pro',
];

// gpt-oss / deepseek are REASONING models: the final answer may sit in
// message.reasoning_content instead of message.content, and they need enough
// max_tokens to finish thinking AND still emit the answer. Extract robustly.
function extractReply(msg) {
  return (msg?.content && msg.content.trim())
    || (msg?.reasoning_content && `[from reasoning_content] ${msg.reasoning_content.trim()}`)
    || '(empty — model used all tokens reasoning; raise max_tokens)';
}

const money = (n) => `$${n.toFixed(6)}`;

async function listModels() {
  console.log('\n=== 1. Auth + available models ===');
  try {
    const res = await client.models.list();
    const ids = (res.data || []).map((m) => m.id);
    console.log(`✅ Key valid. ${ids.length} model(s) visible to this account.`);
    // Show a sample so we can see real ids (gpt-oss / qwen / llama etc.)
    const interesting = ids.filter((id) => /gpt-oss|qwen|llama|deepseek/i.test(id));
    console.log('   Relevant models:', interesting.length ? interesting : ids.slice(0, 15));
    return ids;
  } catch (e) {
    console.error('❌ Model list failed:', e.status || '', e.message);
    console.error('   (If 401 → bad/expired key. If 403 → key lacks permission.)');
    return null;
  }
}

async function pickWorkingModel() {
  for (const model of CANDIDATES) {
    try {
      await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
      });
      return model;
    } catch (e) {
      console.log(`   (skip ${model} — ${e.status || ''} ${e.message})`);
    }
  }
  return null;
}

async function basicReply(model) {
  console.log('\n=== 2. Basic chat completion ===');
  const t = Date.now();
  const r = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are a helpful WhatsApp sales assistant for a football jersey store.' },
      { role: 'user', content: 'Do you have Real Madrid jerseys?' },
    ],
    max_tokens: 600,
  });
  console.log(`✅ ${Date.now() - t}ms  model=${model}`);
  console.log('   Reply:', extractReply(r.choices[0].message));
  const u = r.usage;
  if (u) {
    // gpt-oss-120b pricing: $0.15/M in, $0.60/M out
    const cost = (u.prompt_tokens / 1e6) * 0.15 + (u.completion_tokens / 1e6) * 0.60;
    console.log(`   Tokens: ${u.prompt_tokens} in / ${u.completion_tokens} out  ≈ ${money(cost)} (~₹${(cost * 88).toFixed(4)})`);
  }
}

async function toolCalling(model) {
  console.log('\n=== 3. Function/tool-calling (critical for ai.js) ===');
  const tools = [{
    type: 'function',
    function: {
      name: 'search_products',
      description: 'Search the jersey catalog',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'what to search for' } },
        required: ['query'],
      },
    },
  }];
  const r = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Show me Barcelona jerseys' }],
    tools,
    tool_choice: 'auto',
    max_tokens: 120,
  });
  const call = r.choices[0].message.tool_calls?.[0];
  if (call) {
    console.log(`✅ Tool call emitted: ${call.function.name}(${call.function.arguments})`);
  } else {
    console.log('⚠️  No tool call — model replied with text instead:', r.choices[0].message.content?.trim());
    console.log('   (If this happens consistently, this model is NOT suitable as-is for the agentic loop.)');
  }
}

async function tanglish(model) {
  console.log('\n=== 4. Tanglish code-mixing quality ===');
  const r = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'Reply naturally in Tanglish (Tamil written in English letters mixed with English), like a friendly Chennai shopkeeper.' },
      { role: 'user', content: 'Bro Barcelona jersey stock irukka? Price enna?' },
    ],
    max_tokens: 600,
  });
  console.log('   Reply:', extractReply(r.choices[0].message));
}

(async () => {
  console.log('🔥 Fireworks AI smoke test');
  const ids = await listModels();
  const model = (await pickWorkingModel());
  if (!model) {
    console.error('\n❌ None of the candidate models responded. Check ids above and edit CANDIDATES.');
    process.exit(1);
  }
  // Compare every candidate that actually exists on the account, side by side.
  const available = CANDIDATES.filter((m) => !ids || ids.includes(m));
  for (const m of available) {
    console.log(`\n\n########## MODEL: ${m} ##########`);
    try {
      await basicReply(m);
      await toolCalling(m);
      await tanglish(m);
    } catch (e) {
      console.error(`❌ ${m} failed:`, e.status || '', e.message);
    }
  }
  console.log('\n✅ Done. Compare the two models above and tell me which reply quality you prefer.');
})();

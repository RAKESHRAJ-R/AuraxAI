/**
 * Owner rule documents — `npm run test-owner-rules`.
 *
 * The client changes how the bot behaves by uploading a rules document in the Knowledge Hub
 * (services/rules.js). This drives that whole path with a STUBBED model: no paid call is made,
 * nothing is sent, and all data lives in a temp dir.
 *
 *   upload → rules read once → in every prompt → contradicted FAQ answers switched off
 *   → a newer document wins → turning it off / deleting it restores the built-in behaviour
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-rules-'));

const dbService = (await import('./services/db.js')).default;
const rulesService = (await import('./services/rules.js')).default;
const { parseDigest } = await import('./services/rules.js');
const aiService = (await import('./services/ai.js')).default;
const retrievalService = (await import('./services/retrieval.js')).default;
await dbService.ready;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
}

// A fake condenser: returns whatever the test says the document's rules are, and records
// what it was sent so we can check the FAQ list and the document text reached it.
let condenserInput = null;
const condenser = (reply) => async (messages) => { condenserInput = messages; return { content: reply, provider: 'stub' }; };

async function addDocument(title, text, createdAt) {
  const src = await dbService.saveKnowledgeSource({ type: 'document', title, filename: `${title}.pdf`, chunkCount: 1, charCount: text.length, createdAt });
  await dbService.replaceKnowledgeChunks(src.id, [{ text, sourceType: 'document' }]);
  return src;
}

console.log('\n1. Parsing the condenser reply');
{
  const cats = ['Customization', 'Payment', 'Shipping & Delivery'];
  const p = parseDigest('RULES:\n- Name print is ₹350\n- Delivery 4-6 days\n\nFAQ_CONFLICTS:\nCustomization | shipping & delivery | Made Up Category', cats);
  check('rule text extracted', p.text === '- Name print is ₹350\n- Delivery 4-6 days', p.text);
  check('conflicts matched case-insensitively, unknown dropped', JSON.stringify(p.faqConflicts) === JSON.stringify(['Customization', 'Shipping & Delivery']), p.faqConflicts);
  check('NONE means no conflicts', parseDigest('RULES:\n- x\nFAQ_CONFLICTS:\nNONE', cats).faqConflicts.length === 0);
  let threw = false;
  try { parseDigest('RULES:\n\nFAQ_CONFLICTS: NONE', cats); } catch { threw = true; }
  check('an empty rule sheet is an error, not silent', threw);
}

console.log('\n2. Upload → rules read once → stored on the document');
const v1 = await addDocument('Rules v1', 'Name customisation costs ₹350 extra. Delivery is 4–6 working days. Always greet with "Welcome to Aura".', '2026-09-01T00:00:00.000Z');
await rulesService.digest(v1.id, { llm: condenser('RULES:\n- Name customisation costs ₹350 extra.\n- Delivery is 4–6 working days.\n- Always greet with "Welcome to Aura".\n\nFAQ_CONFLICTS:\nCustomization | Shipping & Delivery') });
const stored = (await dbService.getAllKnowledgeSources()).find(s => s.id === v1.id);
check('rules saved on the source', stored.rules?.status === 'ready' && /₹350/.test(stored.rules.text), JSON.stringify(stored.rules));
check('the condenser saw the whole document', /Welcome to Aura/.test(condenserInput?.[1]?.content || ''));
check('the condenser saw the current FAQ answers', /Customization: .*₹300/.test(condenserInput?.[1]?.content || ''));

console.log('\n3. The rules are in every prompt, and replace the built-in facts');
await rulesService.refresh();
for (const language of ['english', 'tanglish']) {
  const prompt = aiService.generateSystemPrompt({ language, cart: [] });
  check(`${language}: owner rules present`, /OWNER RULES/.test(prompt) && /₹350 extra/.test(prompt));
  check(`${language}: built-in ₹300 fact gone (no two versions of one fact)`, !/₹300/.test(prompt));
  check(`${language}: owner rules sit before the per-turn session state (prompt cache)`, prompt.indexOf('OWNER RULES') < prompt.indexOf('Current Session Context'));
}

console.log('\n4. FAQ answers the document contradicts are no longer served');
check('Customization + Shipping switched off', rulesService.disabledFaqCategories().has('Customization') && rulesService.disabledFaqCategories().has('Shipping & Delivery'));
{
  const SENDER = '919000000077@c.us';
  await dbService.saveSession(SENDER, { state: 'IDLE', cart: [], address: null, history: [], language: 'english', lastShownProducts: [], firstContactLogged: true });
  let sentPrompt = '';
  const original = aiService.callLLMWithRetry;
  aiService.callLLMWithRetry = async (messages) => {
    sentPrompt = messages.find(m => m.role === 'system')?.content || '';
    return { choices: [{ message: { role: 'assistant', content: 'Name customisation is ₹350 extra. Which jersey?', tool_calls: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  };
  try {
    const r = await aiService.answerQuery(SENDER, 'can i customize the name');
    check('"can i customize the name" skips the stale FAQ', r.intent !== 'faq', `${r.intent}: ${r.replyText}`);
    check('...and the agent got the owner rules', /₹350 extra/.test(sentPrompt));
    const r2 = await aiService.answerQuery(SENDER, 'COD iruka?');
    check('an FAQ the document did not contradict still answers instantly', r2.intent === 'faq', r2.intent);
  } finally {
    aiService.callLLMWithRetry = original;
  }
}

console.log('\n5. A newer document wins');
const v2 = await addDocument('Rules v2', 'Name customisation is now ₹400.', '2026-09-20T00:00:00.000Z');
await rulesService.digest(v2.id, { llm: condenser('RULES:\n- Name customisation is now ₹400.\n\nFAQ_CONFLICTS:\nCustomization') });
await rulesService.refresh();
{
  const prompt = aiService.generateSystemPrompt({ language: 'english', cart: [] });
  check('both documents are in the prompt, older first', prompt.indexOf('Rules v1') < prompt.indexOf('Rules v2'), prompt.slice(0, 200));
  check('the prompt says the later upload wins', /uploaded LATER wins/.test(prompt));
}

console.log('\n6. A document with no rules stays reference material');
const manual = await addDocument('Care manual', 'Wash inside out in cold water.', '2026-09-21T00:00:00.000Z');
await rulesService.digest(manual.id, { llm: condenser('RULES:\nNONE\n\nFAQ_CONFLICTS:\nNONE') });
await rulesService.refresh();
check('not added to the prompt', !/Care manual/.test(aiService.generateSystemPrompt({ language: 'english', cart: [] })));
retrievalService.invalidate();
{
  const chunks = await retrievalService.getChunks();
  check('still searchable as reference', chunks.some(c => c.sourceId === manual.id));
  check('rule documents are NOT searched (their "WRONG:" examples must not leak in)', !chunks.some(c => c.sourceId === v1.id));
}

console.log('\n7. Hand edits, failures, turning off, deleting');
await rulesService.setText(v2.id, '- Name customisation is now ₹450.');
await rulesService.refresh();
check('a hand edit is used word for word', /₹450/.test(aiService.generateSystemPrompt({ language: 'english', cart: [] })));
{
  const broken = await addDocument('Broken', 'Some rules.', '2026-09-22T00:00:00.000Z');
  const saved = await rulesService.digest(broken.id, { llm: async () => { throw new Error('provider down'); } });
  check('a failed read is recorded, not thrown', saved.rules?.status === 'error' && /provider down/.test(saved.rules.error));
  let calls = 0;
  const origDigest = rulesService.digest.bind(rulesService);
  rulesService.digest = async (...a) => { calls++; return origDigest(...a); };
  await rulesService.backfill();
  rulesService.digest = origDigest;
  check('a failed document is not retried on every boot (no repeated cost)', calls === 0, `${calls} calls`);
}
for (const s of await dbService.getAllKnowledgeSources()) {
  if (s.id !== v1.id && s.id !== v2.id) await dbService.deleteKnowledgeSource(s.id);
}
await dbService.saveKnowledgeSource({ ...(await dbService.getAllKnowledgeSources()).find(s => s.id === v2.id), active: false });
await dbService.deleteKnowledgeSource(v1.id);
rulesService.invalidate();
await rulesService.refresh();
{
  const prompt = aiService.generateSystemPrompt({ language: 'english', cart: [] });
  check('with every rule document off/deleted, the built-in facts come back', /STORE FACTS/.test(prompt) && /₹300/.test(prompt) && !/OWNER RULES/.test(prompt));
  check('...and the FAQ answers are served again', rulesService.disabledFaqCategories().size === 0);
}

console.log(`\n${failed ? 'FAILED' : 'ALL CHECKS PASSED'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

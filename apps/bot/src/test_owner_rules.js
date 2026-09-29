/**
 * The Rule Book — `npm run test-owner-rules`.
 *
 * The client changes how the bot behaves by uploading documents in the Knowledge Hub
 * (services/rules.js). This drives the whole path with NO AI anywhere: the Rule Book itself
 * never calls a model, and the one agent reply at the end uses a stubbed model. Nothing is
 * sent, and all data lives in a temp dir.
 *
 *   upload → split into rule cards → "always" rules in the prompt, topic rules per message
 *   → stale FAQ answers step aside → a new version merges (changed / new / missing, never
 *   silently forgotten) → turning it off / deleting it restores the built-in behaviour
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-rules-'));

const dbService = (await import('./services/db.js')).default;
const rules = await import('./services/rules.js');
const rulesService = rules.default;
const { splitIntoCards, tagTopics, messageTopics, numbersIn, docKeyFor, joinChunks } = rules;
const aiService = (await import('./services/ai.js')).default;
const retrievalService = (await import('./services/retrieval.js')).default;
const textExtractService = (await import('./services/textextract.js')).default;
await dbService.ready;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
}

// The Rule Book must never reach for a model. Any LLM call outside the agent test fails loudly.
let llmCalls = 0;
let agentReply = null;
let lastMessages = [];
aiService.callLLMWithRetry = async (messages) => {
  llmCalls++;
  lastMessages = messages;
  if (!agentReply) throw new Error('unexpected LLM call');
  return { choices: [{ message: { role: 'assistant', content: agentReply, tool_calls: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
};

const GUIDE_V1 = `AURA EXCHANGE WHATSAPP CHATBOT MASTER TRAINING GUIDE
-- 1 of 13 --
Table of Contents
1. Tone and Language ........ 2
2. Jersey Versions ........ 3
1. TONE AND LANGUAGE
The bot must reply in the same language the customer uses. Use neenga / unga, never machan,
mame, da or dei.
• Use "bro" only if the customer uses it first, at most once per reply.
WRONG: "Machan enna venum da?"
2. JERSEY VERSIONS
Imported jerseys come in 4 versions:
• FC Set — jersey + shorts with embroidered badges. Only the FC Set comes with
shorts.
• Player Version — dry-fit fabric, heat-pressed logos.
3. Name Customisation
Player name on the back is not included. Name customisation costs ■350 extra.
Customised orders take 8–10 working days.
4. Delivery Time
Standard delivery: 5–7 working days. Never promise an exact date.
Page 4 of 13
5. Wholesale Enquiries
Reply exactly: "For Wholesale Prices, Collections & Enquiries Contact: 9360715443". Never quote
wholesale prices.
6. Returns
Never state a return or exchange policy. Say the team will check and decide.`;

async function upload(title, text, { createdAt, replaces } = {}) {
  const src = await dbService.saveKnowledgeSource({ type: 'document', title, filename: `${title}.pdf`, chunkCount: 1, charCount: text.length, createdAt });
  await dbService.replaceKnowledgeChunks(src.id, [{ text, sourceType: 'document' }]);
  return rulesService.ingest(src.id, { text, replaces });
}
const allCards = () => dbService.getAllRuleCards();
const prompt = (language = 'english') => aiService.generateSystemPrompt({ language, cart: [] });
async function ctx(q, prev = '') { await rulesService.refresh(); return rulesService.contextFor(q, prev)?.content || ''; }

console.log('\n1. Splitting a document — code only, nothing summarised');
{
  const cards = splitIntoCards(GUIDE_V1, { title: 'Guide' });
  const heads = cards.map(c => c.heading);
  check('one card per section (6)', cards.length === 6, heads.join(' | '));
  check('the title line, table of contents and page markers are not rules', !cards.some(c => /Table of Contents|\.{4}|1 of 13|Page 4/.test(c.heading + c.text)), heads.join(' | '));
  const cust = cards.find(c => /Customisation/.test(c.heading));
  check('a PDF "■350" is read as ₹350', /₹350/.test(cust?.text || ''), cust?.text);
  const ver = cards.find(c => /VERSIONS/.test(c.heading));
  check('a bullet wrapped onto the next line is joined back', /Only the FC Set comes with shorts\./.test(ver?.text || ''), ver?.text);
  check('every rule line of the document is kept', /at most once per reply/.test(cards[0].text) && /WRONG: "Machan/.test(cards[0].text));
  check('"3. Always greet the customer" is a list item, not a heading',
    splitIntoCards('RULES\n3. Always greet the customer warmly\n4. Reply fast').length === 1);
  const long = splitIntoCards(`BIG SECTION\n${Array.from({ length: 30 }, (_, i) => `• Rule number ${i} says something fairly long about the store.`).join('\n')}`);
  check('a long section becomes several cards, never cut mid-line', long.length > 1 && long.every(c => c.text.length <= 900 && !/^\s*says/.test(c.text)), long.map(c => c.text.length).join(','));
}

console.log('\n2. Topics — English and Tanglish, from one word list');
{
  check('"Delivery ethana naal aagum?" → delivery', messageTopics('Delivery ethana naal aagum?').includes('delivery'));
  check('"name podalama bro?" → customisation', messageTopics('name podalama bro?').includes('customisation'));
  check('"FC set la shorts varuma" → versions + shorts', ['versions', 'shorts'].every(t => messageTopics('FC set la shorts varuma').includes(t)));
  check('"refund venum" → returns', messageTopics('refund venum').includes('returns'));
  check('"hi" → no topic', messageTopics('hi').length === 0);
  check('"customer" does not read as customisation', !tagTopics('Tone', 'Reply in the language the customer uses').includes('customisation'));
  check('heading words weigh most', tagTopics('4. Delivery Time', 'Never promise an exact date.')[0] === 'delivery');
  check('numbers: spaced phone, +91, thousands, ranges', ['9360715443', '1300', '5', '7'].every(n => numbersIn('Call +91 93607 15443 — ₹1,300, 5–7 days').has(n)));
  check('versions share a document key', docKeyFor('AURA_EXCHANGE_Guide_v2 (1).pdf') === docKeyFor('AURA EXCHANGE Guide final.pdf'));
}

console.log('\n3. Upload → Rule Book, with no AI call');
const v1 = await upload('AURA EXCHANGE Guide', GUIDE_V1, { createdAt: '2026-09-01T00:00:00.000Z' });
check('ingested: 6 new cards', v1.summary.added === 6 && v1.summary.cards === 6, JSON.stringify(v1.summary));
check('no model was called to read it', llmCalls === 0, `${llmCalls} calls`);
check('the upload text is kept on the source (re-reading needs no chunks)', typeof v1.source.fullText === 'string' && v1.source.fullText.includes('■350'));
{
  const tone = (await allCards()).find(c => /TONE/.test(c.heading));
  check('the tone section is an "always" rule', tone?.always === true);
}
await rulesService.refresh();
for (const language of ['english', 'tanglish']) {
  const p = prompt(language);
  check(`${language}: "always" rules are in the system prompt`, /OWNER RULES/.test(p) && /neenga \/ unga/.test(p));
  check(`${language}: topic rules are NOT in the system prompt (they come per message)`, !/₹350/.test(p) && !/Standard delivery: 5–7/.test(p));
  check(`${language}: built-in facts the document covers are gone (no two versions of one fact)`, !/₹300/.test(p) && !/5–7 working days; customised/.test(p));
  check(`${language}: built-in facts the document does NOT cover stay (giveaway)`, /Giveaway → it was cancelled/.test(p));
  check(`${language}: the rules sit before the per-turn session state (prompt cache)`, p.indexOf('OWNER RULES') < p.indexOf('Current Session Context'));
}

console.log('\n4. The right rules for each message');
{
  const d = await ctx('Delivery ethana naal aagum?');
  check('Tanglish delivery question gets the delivery rule', /5–7 working days/.test(d), d);
  check('...and the customised-delivery rule (8–10 days)', /8–10 working days/.test(d), d);
  check('...but not the wholesale rule', !/9360715443/.test(d), d);
  const w = await ctx('bulk order for my team, 20 pieces');
  check('wholesale question gets the exact wholesale reply', /9360715443/.test(w), w);
  check('"hi" gets no rules (costs nothing)', (await ctx('hi')) === '');
  const f = await ctx('what about for kids?', 'name print evlo?');
  check('a follow-up with no topic uses the previous message\'s topic', /₹350/.test(f), f);
  check('the injected rules are capped', (await ctx('delivery price name size return wholesale version shorts payment')).length <= 2600);
}

console.log('\n5. Stale FAQ answers step aside — decided by numbers, no AI');
await rulesService.refresh();
{
  const off = rulesService.disabledFaqCategories();
  check('Customization FAQ (₹300) is switched off — the document says ₹350', off.has('Customization'), [...off].join(', '));
  check('Shipping FAQ (5–7, 8–10) agrees with the document and stays on', !off.has('Shipping & Delivery'), [...off].join(', '));
  check('Wholesale FAQ (same phone number) stays on', !off.has('Wholesale / Bulk Orders'), [...off].join(', '));
  check('an FAQ on a topic the document never mentions stays on (Giveaway)', !off.has('Giveaway'));

  const SENDER = '919000000077@c.us';
  await dbService.saveSession(SENDER, { state: 'IDLE', cart: [], address: null, history: [], language: 'english', lastShownProducts: [], firstContactLogged: true });
  agentReply = 'Name customisation is ₹350 extra. Which jersey?';
  try {
    const r = await aiService.answerQuery(SENDER, 'can i customize the name');
    check('"can i customize the name" skips the stale FAQ', r.intent !== 'faq', `${r.intent}: ${r.replyText}`);
    check('...and the agent was given the owner\'s ₹350 rule with the message', lastMessages.some(m => m.role === 'system' && /OWNER RULES FOR THIS QUESTION/.test(m.content) && /₹350/.test(m.content)));
    const before = llmCalls;
    const r2 = await aiService.answerQuery(SENDER, 'delivery time?');
    check('an FAQ that agrees with the document still answers for free', r2.intent === 'faq' && llmCalls === before, `${r2.intent}, ${llmCalls - before} LLM calls`);
  } finally {
    agentReply = null;
  }
}

console.log('\n6. A new version merges — changed, new and missing, nothing silently forgotten');
{
  const tone = (await allCards()).find(c => /TONE/.test(c.heading));
  await rulesService.updateCard(tone.id, { text: `${tone.text}\n• Staff note: always say thanks.` });
  const deliv = (await allCards()).find(c => /Delivery Time/.test(c.heading));
  await rulesService.updateCard(deliv.id, { text: 'Delivery 5–7 days (edited by staff).' });
}
const GUIDE_V2 = GUIDE_V1
  .replace('Standard delivery: 5–7 working days.', 'Standard delivery: 4–6 working days.')
  .replace(/6\. Returns[\s\S]*$/, '6. Giveaway\nThe giveaway is cancelled for now; it will be announced soon.');
const v2 = await upload('AURA_EXCHANGE_Guide_v2', GUIDE_V2, { createdAt: '2026-09-20T00:00:00.000Z' });
{
  const s = v2.summary;
  check('recognised as a new version of the same document (by title)', s.unchanged >= 4, JSON.stringify(s));
  check('1 changed (delivery), 1 new (giveaway), 1 missing (returns)', s.changed === 1 && s.added === 1 && s.missing === 1, JSON.stringify(s));
  const sources = (await dbService.getAllKnowledgeSources()).filter(x => x.type === 'document');
  check('the old version\'s record is replaced — one document, not two', sources.length === 1 && sources[0].id === v2.source.id, sources.map(x => x.title).join(', '));
  const cards = await allCards();
  const deliv = cards.find(c => /Delivery Time/.test(c.heading));
  check('the new version beats a staff edit of a rule it changed', /4–6 working days/.test(deliv.text) && /5–7 days \(edited/.test(deliv.previousText || ''), deliv.text);
  const tone = cards.find(c => /TONE/.test(c.heading));
  check('a staff edit of a rule the new version did NOT change is kept', /always say thanks/.test(tone.text));
  const ret = cards.find(c => /Returns/.test(c.heading));
  check('the dropped rule is marked MISSING, not deleted', ret?.status === 'missing');
  check('...and the bot still follows it until someone decides', /Never state a return/.test(await ctx('refund venum')));
}

console.log('\n7. Keep or remove a missing rule; staff-added rules; an explicit "new version of"');
{
  const ret = (await allCards()).find(c => /Returns/.test(c.heading));
  await rulesService.resolveMissing(ret.id, 'keep');
  const v3 = await upload('Totally different name', GUIDE_V2, { createdAt: '2026-09-21T00:00:00.000Z', replaces: v2.source.id });
  check('"new version of" links a differently named file', v3.summary.added === 0 && v3.summary.unchanged >= 5, JSON.stringify(v3.summary));
  const kept = (await allCards()).find(c => /Returns/.test(c.heading));
  check('a kept rule survives the next version', kept?.status === 'ok' && kept.manual === true);
  await rulesService.addCard({ heading: 'Diwali offer', text: 'Diwali: 10% off every jersey until Nov 5.', topics: ['price'] });
  check('a rule typed in by staff is used for its topic', /Diwali/.test(await ctx('any offer on price?')));
  const d = (await allCards()).find(c => /Diwali/.test(c.heading));
  await rulesService.resolveMissing(d.id, 'remove');
  check('remove deletes a rule', !(await allCards()).some(c => /Diwali/.test(c.heading)));
}

console.log('\n8. A different document adds to the book; the newer one comes first');
{
  const other = await upload('Delivery Time Policy', 'DELIVERY TIME POLICY\nDuring festival season delivery takes 7–9 working days.', { createdAt: '2026-09-25T00:00:00.000Z' });
  check('added alongside, not merged', other.summary.added === 1 && (await dbService.getAllKnowledgeSources()).filter(s => s.type === 'document').length === 2);
  const d = await ctx('delivery eppo varum?');
  check('both documents\' delivery rules are given, newest first', d.indexOf('7–9') > -1 && d.indexOf('7–9') < d.indexOf('4–6'), d);
}

console.log('\n9. Topic words staff add work immediately');
{
  check('"thapaal eppo" matches nothing yet', !messageTopics('thapaal eppo').includes('delivery'));
  await rulesService.setTopicWords('delivery', { words: ['thapaal'] });
  await rulesService.refresh();
  check('after adding "thapaal" to delivery, it does', /working days/.test(await ctx('thapaal eppo')));
}

console.log('\n10. Retrieval, re-reading, and documents uploaded before the Rule Book');
{
  retrievalService.invalidate();
  const chunks = await retrievalService.getChunks();
  check('Rule Book documents are NOT also searched as chunks ("WRONG:" lines must not leak in)', chunks.length === 0, chunks.length);
  const before = (await allCards()).length;
  const src = (await dbService.getAllKnowledgeSources()).find(s => /Delivery Time Policy/.test(s.title));
  const again = await rulesService.ingest(src.id);
  check('re-reading an unchanged document changes nothing', again.summary.unchanged === again.summary.cards && (await allCards()).length === before);

  // An old upload: chunks only, no fullText, no ruleBook — rebuilt from the overlapping chunks.
  const oldText = `SIZE GUIDE\n${Array.from({ length: 40 }, (_, i) => `• Size note ${i}: chest measurements vary by version, check the chart.`).join('\n')}`;
  const pieces = textExtractService.chunk(oldText);
  check('(fixture) the old upload really spans overlapping chunks', pieces.length > 1);
  check('joinChunks rebuilds the text without the overlap', joinChunks(pieces).replace(/\s+/g, ' ') === textExtractService.normalize(oldText).replace(/\s+/g, ' '));
  const legacy = await dbService.saveKnowledgeSource({ type: 'document', title: 'Size guide', createdAt: '2026-09-26T00:00:00.000Z' });
  await dbService.replaceKnowledgeChunks(legacy.id, pieces.map(text => ({ text })));
  const n = await rulesService.backfill();
  check('backfill splits the old upload, free', n === 1 && llmCalls === 1 && (await allCards()).some(c => /Size note 39/.test(c.text)), `${n} docs, ${llmCalls} LLM calls`);
  check('...and does nothing on the next boot', (await rulesService.backfill()) === 0);
}

console.log('\n11. Turning off and deleting');
{
  for (const s of await dbService.getAllKnowledgeSources()) {
    await dbService.saveKnowledgeSource({ ...s, active: false });
  }
  rulesService.invalidate();
  await rulesService.refresh();
  const p = prompt();
  check('documents off → only hand-kept rules remain in force', rulesService.state().cards.every(c => c.manual));
  check('...the built-in delivery fact is back', /5–7 working days; customised/.test(p));
  for (const s of await dbService.getAllKnowledgeSources()) {
    await rulesService.removeDocument(s);
    await dbService.deleteKnowledgeSource(s.id);
  }
  const left = await allCards();
  check('deleting documents deletes their rules, but not ones staff chose to keep', left.length === 1 && /Returns/.test(left[0].heading), left.map(c => c.heading).join(', '));
  await rulesService.deleteCard(left[0].id);
  rulesService.invalidate();
  await rulesService.refresh();
  check('an empty Rule Book restores the built-in facts exactly', /^STORE FACTS/m.test(prompt()) && /₹300/.test(prompt()) && !/OWNER RULES/.test(prompt()));
  check('...and every FAQ answer is served again', rulesService.disabledFaqCategories().size === 0);
}

console.log(`\n${failed ? 'FAILED' : 'ALL CHECKS PASSED'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

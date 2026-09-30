/**
 * Tanglish logic — `npm run test-tanglish-logic`.
 *
 * The client (2026-09-29): "our bot is working fine in English, the main problem is in
 * Tanglish", with a complaint reply that was meaningless in places. This suite covers the
 * fixes, with a STUBBED model — no paid call, nothing sent, data in a temp dir:
 *
 *   - the Tanglish message is read in code (meanings glossed, questions counted)
 *   - hard Tanglish turns let Sarvam think; easy ones stay fast (/no_think)
 *   - a complaint gets a fixed, human-written first reply instead of free-written Tamil
 *   - the broken forms from the client's screenshot trigger a rewrite
 *   - a price or number of days the model never read anywhere triggers a rewrite
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-tlogic-'));

const dbService = (await import('./services/db.js')).default;
const aiService = (await import('./services/ai.js')).default;
// These suites cover the action layer and the keyword fallback: the understanding step
// (services/understand.js) is tested on its own in test_understanding.js.
aiService.understandMessage = async () => null;
const faqService = (await import('./services/faq.js')).default;
const t = await import('./services/tanglish.js');
await dbService.ready;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
}

// Every LLM call is recorded; replies are served from a script, in order.
let calls = [];
let script = [];
aiService.callLLMWithRetry = async (messages, client, provider, keyIndex, language, opts = {}) => {
  calls.push({ messages: messages.map(m => ({ ...m })), provider, language, opts });
  const content = script.length ? script.shift() : 'Seri, sollunga.';
  return { choices: [{ message: { role: 'assistant', content, tool_calls: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
};

let n = 0;
async function fresh(language = 'tanglish', extra = {}) {
  const id = `9190000${String(++n).padStart(5, '0')}@c.us`;
  await dbService.saveSession(id, { state: 'IDLE', cart: [], address: null, history: [], language, lastShownProducts: [], firstContactLogged: true, lastActive: new Date().toISOString(), ...extra });
  return id;
}
async function ask(id, text, replies = []) {
  calls = [];
  script = [...replies];
  return aiService.answerQuery(id, text);
}
const noteIn = (c) => c?.messages.find(m => m.role === 'system' && /READ FOR YOU/.test(m.content))?.content || '';

const SCREENSHOT = 'Sorry bro, neenga ivlo upset aagirukka na naanum feel panren. Service miss pannite ah naurom nu ninaikirenga nu puriyuthu. 😔 Enna problem-na nu konjam solla mudiyuma? Order ID iruntha anuppunga, appo pathi naan immediate ah look panniten. Innum vera enna chance irukku nu sollunga, naan fix pannanum nu dhaan nenaikirenga.';

console.log('\n1. The client\'s screenshot reply is caught');
{
  const problems = aiService.tanglishProblems(SCREENSHOT, 'tanglish');
  for (const [label, re] of [['"naurom"', /naurom/], ['"appo pathi"', /appo pathi/], ['"look panniten" (claims it is already done)', /look panniten/], ['"nu … ninaikirenga" (guessing their thoughts)', /ninaikirenga|nenaikirenga/], ['chained "nu … nu"', /two "nu" clauses/]]) {
    check(`flags ${label}`, problems.some(p => re.test(p)), problems.join(' | '));
  }
  check('English sessions are never checked', aiService.tanglishProblems(SCREENSHOT, 'english').length === 0);
}

console.log('\n2. Good Tanglish is NOT flagged (a false alarm costs a paid rewrite)');
{
  const good = [
    'Romba sorry 🙏 Idha naanga kandippa sort out panrom.\nUnga order ID um, enna problem nu oru line la anuppunga. Photo irundha adhuvum anuppunga.\nTeam udane check pannuvaanga.',
    'Real Madrid jersey stock la iruku, size sollunga.',
    'Enna jersey venum nu sollunga.',
    'Delivery 5–7 working days aagum. Customised na 8–10 days.',
    'Check panren, oru nimisham.',
    aiService.brokenReplyFallback('tanglish'),
    ...faqService.getFAQs().map(f => f.answerTanglish).filter(Boolean),
  ];
  const flagged = good.map(g => [g, aiService.tanglishProblems(g, 'tanglish')]).filter(([, p]) => p.length);
  check(`${good.length} approved Tanglish texts (incl. every FAQ answer) pass`, flagged.length === 0, flagged.map(([g, p]) => `${g.slice(0, 60)} → ${p}`).join(' || '));
}

console.log('\n3. Reading Tanglish in code');
{
  check('glosses "varuma"', /varuma\(=will it come/.test(t.gloss('FC set la shorts varuma').text));
  check('"size M irukka, price evlo" is two questions', t.questionsIn('size M irukka, price evlo').length === 2);
  check('"FC set la shorts varuma? size M irukka" is two questions', t.questionsIn('FC set la shorts varuma? size M irukka').length === 2);
  check('"Real Madrid jersey iruka bro" is one question', t.questionsIn('Real Madrid jersey iruka bro').length === 1);
  check('"naalu" is not read as "days" (it means four)', !/days/.test(t.gloss('naalu jersey venum').text));
  check('complaint: "order pannen innum varala"', t.isComplaint('order pannen innum varala'));
  check('complaint: "jersey damage aayiduchu"', t.isComplaint('jersey damage aayiduchu'));
  check('not a complaint: "Barcelona jersey iruka"', !t.isComplaint('Barcelona jersey iruka'));
  check('hard: two questions', t.isHard('size M irukka, price evlo'));
  check('hard: a comparison', t.isHard('Player version vs fan version edhu nalladhu?'));
  check('hard: a change mid-order', t.isHard('size maathanum', { orderActive: true }));
  check('easy: one simple question', !t.isHard('Real Madrid jersey iruka bro'));
  check('easy: a bare team / "2 M 5"', !t.isHard('Barcelona') && !t.isHard('2 M 5'));
}

console.log('\n4. Sarvam thinks only on hard turns');
{
  let sent = null;
  const fakeClient = { chat: { completions: { create: async (req) => { sent = req; return { choices: [{ message: { content: 'ok' } }] }; } } } };
  const original = Object.getPrototypeOf(aiService).callLLMWithRetry;
  const base = [{ role: 'system', content: 'PROMPT' }, { role: 'user', content: 'hi' }];
  await original.call(aiService, base, fakeClient, 'sarvam', 0, 'tanglish', {});
  check('easy turn: /no_think added, 800 tokens', /\/no_think$/.test(sent.messages[0].content) && sent.max_tokens === 800, `${sent.messages[0].content} / ${sent.max_tokens}`);
  await original.call(aiService, base, fakeClient, 'sarvam', 0, 'tanglish', { think: true });
  check('hard turn: no /no_think, 1500 tokens of room', !/no_think/.test(sent.messages[0].content) && sent.max_tokens === 1500, `${sent.messages[0].content} / ${sent.max_tokens}`);
  await original.call(aiService, base, fakeClient, 'fireworks', 0, 'tanglish', { think: true });
  check('other providers\' prompts are untouched', sent.messages[0].content === 'PROMPT');
}

console.log('\n5. Through the real reply path');
{
  const id = await fresh();
  const r = await ask(id, 'order pannen innum varala, romba late');
  check('a Tanglish complaint gets the fixed reply, no AI call', r.intent === 'deterministic_complaint' && calls.length === 0, `${r.intent} / ${calls.length} calls`);
  check('...which asks for the order ID and promises (not claims) a check', /order ID/.test(r.replyText) && /check pannuvaanga/.test(r.replyText) && aiService.tanglishProblems(r.replyText, 'tanglish').length === 0, r.replyText);
  const r2 = await ask(id, 'innum varala bro, enna aachu', ['Unga order ID sollunga, team check pannuvaanga.']);
  check('asked again within 30 min → the agent answers (no repeated template)', r2.intent !== 'deterministic_complaint' && calls.length >= 1, r2.intent);
  check('...and it thinks, because it is a complaint', calls[0]?.opts?.think === true);
}
{
  const id = await fresh();
  const r = await ask(id, 'order 77992 innum varala', ['Order 77992 ah team check pannuvaanga. Konjam wait pannunga.']);
  check('a complaint WITH an order number goes to the agent', r.intent !== 'deterministic_complaint' && calls.length >= 1, r.intent);
}
{
  const id = await fresh();
  await ask(id, 'FC set la shorts varuma? size M irukka', ['Aamaa, FC Set la shorts varum. Size M sollunga, check panren.']);
  const note = noteIn(calls[0]);
  check('the model gets the meaning, glossed', /varuma\(=will it come/.test(note), note);
  check('...with both questions listed to answer in order', /asked 2 things/.test(note) && /1\. FC set/.test(note) && /2\. size M/.test(note), note);
  check('...placed right before the customer\'s message', (() => { const ms = calls[0].messages; const i = ms.findIndex(m => /READ FOR YOU/.test(m.content || '')); return i === ms.length - 2 && ms[ms.length - 1].role === 'user'; })());
  check('...and it thinks (two questions)', calls[0].opts.think === true);
}
{
  const id = await fresh();
  await ask(id, 'hmm seri', ['Seri! Enna jersey venum nu sollunga.']);
  check('an easy Tanglish turn does not think', calls[0]?.opts?.think === false);
}
{
  const id = await fresh('english');
  await ask(id, 'Do you have Real Madrid 2009 shirts?', ['Let me check that for you.']);
  check('English: no reading note, no thinking switch', !noteIn(calls[0]) && calls[0].opts.think === false);
}

console.log('\n6. Replies are checked before they are sent');
{
  const id = await fresh();
  const r = await ask(id, 'hmm seri', [SCREENSHOT, 'Sorry 🙏 Order ID anuppunga, team check pannuvaanga.']);
  check('the screenshot reply is rewritten once', calls.length === 2 && /not real Tamil|two "nu" clauses|ALREADY done/.test(calls[1].messages.at(-1).content), calls.map(c => c.messages.at(-1).content.slice(0, 80)).join(' || '));
  check('...and the customer gets the clean one', r.replyText.startsWith('Sorry 🙏 Order ID'), r.replyText);
}
{
  const id = await fresh();
  const r = await ask(id, 'hmm seri', ['Delivery 2–3 naal la varum, ₹650 mattum dhaan!', 'Delivery 5–7 working days aagum.']);
  check('an invented price / days triggers a rewrite', calls.length === 2 && /quoted .*650/.test(calls[1].messages.at(-1).content), calls.map(c => c.messages.at(-1).content.slice(0, 90)).join(' || '));
  check('...and the customer gets the grounded answer', /5–7/.test(r.replyText), r.replyText);
}
{
  check('a figure from the context is fine', aiService.unsupportedFigures('Idhu ₹799, delivery 5–7 days.', [{ content: 'Delivery 5–7 working days' }, { content: '{"price":799}' }]).length === 0);
  check('a total (2 × ₹799 = ₹1598) is fine', aiService.unsupportedFigures('Total ₹1598.', [{ content: '{"price":799}' }]).length === 0);
  check('an unknown price is caught', aiService.unsupportedFigures('Only ₹650!', [{ content: '{"price":799}' }]).join() === '650');
  check('a reply with no price or days is never checked', aiService.unsupportedFigures('Size M venuma?', []).length === 0);
}

console.log(`\n${failed ? 'FAILED' : 'ALL CHECKS PASSED'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

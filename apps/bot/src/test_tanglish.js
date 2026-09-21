/**
 * Tanglish quality + machine-output leakage regression suite.
 *
 *   node src/test_tanglish.js        (npm run test-tanglish)
 *
 * Why this exists
 * ---------------
 * On 2026-09-21 a customer was sent these two messages by the live bot:
 *
 *   "Team perai sollu, best options kaanpida*ven*! 🔥"
 *   "3 jersey ready p\"{ Oru pechu sollu, fast! 🔥"
 *
 * A mid-word markdown marker and a raw escape fragment, both inside otherwise normal
 * sentences, plus invented Tamil word-forms ("theekana", "Chuuda", "pechu sollu") that mean
 * nothing to a Tamil speaker. The same conversation also shows the bot asking "which team?"
 * three times without ever searching, and answering "which teams do you have?" with a list
 * of teams the shop does not stock.
 *
 * Every check below is one of those failures. They run against the real sanitiser, the real
 * catalogue helpers and the real answerQuery egress with a stubbed LLM — no network, no
 * WhatsApp session, no LLM spend, nothing sent, nothing ordered.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// Keep every write off live data — db.js honours AURAX_DATA_DIR (see the admin-auth suite).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-tanglish-'));
process.env.AURAX_DATA_DIR = TMP_DIR;

const aiService = (await import('./services/ai.js')).default;
const woocommerceService = (await import('./services/woocommerce.js')).default;
const dbService = (await import('./services/db.js')).default;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ───────────────────────────── 1. The two live leaks ───────────────────────────── */

section('1. The exact messages that reached a customer on 2026-09-21');

const LIVE_ASTERISK = 'Sure! Which team or player theekana jersey venum bro? Real Madrid, Barcelona, Manchester United laam stock la iruku. Team perai sollu, best options kaanpida*ven*! 🔥';
const LIVE_ESCAPE = 'Sorry bro! 😊 Oru team pechu sollu... Real Madrid, Barcelona, illa enna team? 3 jersey ready p\\"{ Oru pechu sollu, fast! 🔥';

const cleanedAsterisk = aiService.sanitizeOutgoing(LIVE_ASTERISK);
check('mid-word markdown marker is removed', !/kaanpida\*ven/.test(cleanedAsterisk), cleanedAsterisk);
check('...and the sentence around it survives intact', /Real Madrid, Barcelona, Manchester United laam stock la iruku/.test(cleanedAsterisk), cleanedAsterisk);
check('...and no stray asterisk is left behind', !cleanedAsterisk.includes('*'), cleanedAsterisk);

const cleanedEscape = aiService.sanitizeOutgoing(LIVE_ESCAPE);
check('the escape fragment is gone', !/[\\{}]/.test(cleanedEscape), cleanedEscape);
check('...and it is removed as a whole token, not character by character', !/\bp\b/.test(cleanedEscape), cleanedEscape);
check('...and the rest of the message still reads normally', /Real Madrid, Barcelona/.test(cleanedEscape), cleanedEscape);

/* ───────────────────────────── 2. Leak shapes generally ───────────────────────────── */

section('2. Every known shape of machine output');

const LEAKS = [
  ['whole-message tool JSON', '{"type":"function","name":"search_products","parameters":{"query":"chelsea"}}'],
  ['tool JSON inside a sentence', 'Sure bro! {"name":"search_products","arguments":{"query":"messi"}} idhu iruku'],
  ['function tag', 'Bro <function=search_products>{"query":"arsenal"}</function> paarunga'],
  ['unclosed function tag', 'Bro <function( ipo paarunga'],
  ['bare tool name', 'Let me run search_products for you'],
  ['tool call with parens', 'update_cart({"productId": 12, "qty": 2}) done bro'],
  ['chat-template special token', 'Bro iruku <|im_end|> sollunga'],
  ['instruction markers', '[INST] answer the customer [/INST] Bro iruku!'],
  ['reasoning trace', '<think>the customer wants chelsea</think>Bro kandippa iruku!'],
  ['unclosed reasoning trace', 'Bro kandippa iruku! <think>now I should ask for the size'],
  ['tool_calls key', 'Here you go "tool_calls": [ ] bro'],
];

for (const [label, raw] of LEAKS) {
  check(`${label} is detected as machine output`, aiService.looksCorrupted(raw), raw.slice(0, 80));
  const cleaned = aiService.sanitizeOutgoing(raw);
  check(`...and is not present after cleaning (${label})`, cleaned === '' || !aiService.looksCorrupted(cleaned), JSON.stringify(cleaned));
}

check('a reply that is nothing but a leak cleans to empty', aiService.sanitizeOutgoing('{"type":"function","name":"search_products"}') === '');
check('an empty reply counts as corrupted', aiService.looksCorrupted(''));
check('a whitespace-only reply counts as corrupted', aiService.looksCorrupted('   \n  '));

/* ───────────────────────────── 3. What must NOT be damaged ───────────────────────────── */

section('3. Good replies pass through untouched');

const GOOD = [
  'Bro kandippa iruku! 🔥 *Chelsea Home 25/26 Jersey* — ₹849 la kedaikuthu! S, M, L, XL size la iruku. Enna size venum?',
  "Order confirmed! 🎉 Here's your payment link:\nhttps://theaurax.in/checkout/order-pay/123/?pay_for_order=true&key=wc_abc\nOpen the link and pay by UPI, card or net banking!",
  '1. *REAL MADRID 25-26 HOME* — ₹499 [S, M, L, XL]\nhttps://theaurax.in/product/real-madrid-25-26-home/\n2. *FC BARCELONA 25-26* — ₹470 [S, M, L]',
  "Sorry, we don't offer Cash on Delivery — we're prepaid only. 🚚 You can pay by UPI, card or net banking, and shipping is FREE on every order!",
  'Chennai-ku 2-3 days la delivery aagidum bro. Express shipping dhaan! 🚚',
];

for (const good of GOOD) {
  check(`unchanged: "${good.slice(0, 44)}…"`, aiService.sanitizeOutgoing(good) === good, JSON.stringify(aiService.sanitizeOutgoing(good)));
  check('...and is not flagged as corrupted', !aiService.looksCorrupted(good));
}

check('the payment URL survives verbatim — a customer cannot pay without it',
  aiService.sanitizeOutgoing('Pay here: https://theaurax.in/checkout/order-pay/77992/?pay_for_order=true&key=wc_order_abc123')
    .includes('https://theaurax.in/checkout/order-pay/77992/?pay_for_order=true&key=wc_order_abc123'));

check('balanced bold around a product name is kept',
  aiService.sanitizeOutgoing('*AC MILAN 25-26 HOME* — ₹499') === '*AC MILAN 25-26 HOME* — ₹499');
check('an unclosed bold marker is dropped rather than sent',
  aiService.sanitizeOutgoing('*AC MILAN 25-26 HOME — ₹499') === 'AC MILAN 25-26 HOME — ₹499');

/* ───────────────────────────── 4. The sanitiser cannot be skipped ───────────────────── */

section('4. sanitizeOutgoing never throws, whatever it is handed');

for (const weird of [null, undefined, '', 0, 12345, '\u0000\u0007​', '}}}{{{', '\\\\\\', '***', '*']) {
  let threw = null;
  let out;
  try { out = aiService.sanitizeOutgoing(weird); } catch (e) { threw = e; }
  check(`survives ${JSON.stringify(weird)}`, threw === null, threw && threw.message);
  check(`...and returns a string for ${JSON.stringify(weird)}`, typeof out === 'string');
}

/* ───────────────────────────── 5. Tanglish word quality ───────────────────────────── */

section('5. Invented Tamil is detected (and only in Tanglish sessions)');

const INVENTED = [
  'Which team or player theekana jersey venum bro?',
  'Chuuda, endha team venum bro?',
  'Oru team pechu sollu, fast!',
  'Team perai sollu, best options kaanpidaven!',
  'Ungalukku naan eppadi uthavuven?',
  'Vanakkam, வணக்கம் bro',
];

for (const bad of INVENTED) {
  check(`flagged in a Tanglish session: "${bad.slice(0, 40)}…"`, aiService.tanglishProblems(bad, 'tanglish').length > 0);
  check('...and ignored in an English session', aiService.tanglishProblems(bad, 'english').length === 0);
}

const NATURAL = [
  'Bro kandippa iruku! Enna size venum?',
  'Seri bro, cart la potten. Address sollunga — name, address, pincode, mobile number.',
  'Aiyo sorry bro, adhu stock la illa. Vera enna team venum?',
  'Order confirm aayiduchi bro! Idhu unga payment link.',
  'Chennai-ku 2-3 days la delivery aagidum bro. Express shipping dhaan!',
];

for (const good of NATURAL) {
  check(`natural Tanglish is left alone: "${good.slice(0, 44)}…"`, aiService.tanglishProblems(good, 'tanglish').length === 0,
    JSON.stringify(aiService.tanglishProblems(good, 'tanglish')));
}

/* ───────────────────────────── 6. Our own canned Tanglish ───────────────────────────── */

section('6. Every reply the bot writes itself is clean Tanglish');

// The deterministic templates are the replies customers see most, so they are held to the
// same standard as the model's output -- a banned word baked into a template would be worse
// than one the model invented, because it would be sent every single time.
const OWN_REPLIES = [
  aiService.brokenReplyFallback('tanglish'),
  aiService.brokenReplyFallback('english'),
];
for (const reply of OWN_REPLIES) {
  check(`own reply is not corrupted: "${reply.slice(0, 40)}…"`, !aiService.looksCorrupted(reply));
  check('...and survives its own sanitiser unchanged', aiService.sanitizeOutgoing(reply) === reply);
}
check('the Tanglish fallback uses no invented Tamil',
  aiService.tanglishProblems(aiService.brokenReplyFallback('tanglish'), 'tanglish').length === 0,
  JSON.stringify(aiService.tanglishProblems(aiService.brokenReplyFallback('tanglish'), 'tanglish')));

// Cold-lead follow-ups are the one path that speaks FIRST, and they bypass answerQuery
// entirely -- so the egress sanitiser never sees them and their language is not picked by
// the agent. They were English-only until 2026-09-22 regardless of who they went to.
const followupService = (await import('./services/followup.js')).default;
const whatsappWebBot = (await import('./services/whatsapp-web-bot.js')).default;
const originalSendText = whatsappWebBot.sendText;
const originalUpdateLead = dbService.updateLeadFollowUp;
const nudges = [];
whatsappWebBot.sendText = async (to, msg) => { nudges.push(msg); };
dbService.updateLeadFollowUp = async () => {};

const TANGLISH_LEAD = '919000000042@c.us';
const ENGLISH_LEAD = '919000000043@c.us';
await dbService.saveSession(TANGLISH_LEAD, { state: 'IDLE', cart: [], address: null, history: [], language: 'tanglish', lastShownProducts: [] });
await dbService.saveSession(ENGLISH_LEAD, { state: 'IDLE', cart: [], address: null, history: [], language: 'english', lastShownProducts: [] });

await followupService.sendFollowUp({ userId: TANGLISH_LEAD, name: 'Farhan Sadiq', cart: [{ name: 'AC MILAN 25-26 HOME' }], followUpCount: 0 });
await followupService.sendFollowUp({ userId: TANGLISH_LEAD, name: 'Farhan', cart: [], followUpCount: 1 });
await followupService.sendFollowUp({ userId: ENGLISH_LEAD, name: 'John', cart: [], followUpCount: 0 });

whatsappWebBot.sendText = originalSendText;
dbService.updateLeadFollowUp = originalUpdateLead;

check('a Tanglish customer gets a Tanglish follow-up', /pannunga|panringa|venuma/i.test(nudges[0] || ''), nudges[0]);
check('...both of them', /vanthiruku|panringa/i.test(nudges[1] || ''), nudges[1]);
check('...with no invented Tamil in either',
  nudges.slice(0, 2).every(n => aiService.tanglishProblems(n, 'tanglish').length === 0),
  JSON.stringify(nudges.slice(0, 2).map(n => aiService.tanglishProblems(n, 'tanglish'))));
check('an English customer still gets the English follow-up', /Still looking for jerseys/.test(nudges[2] || ''), nudges[2]);
check('no follow-up carries machine output', nudges.every(n => !aiService.looksCorrupted(n)));

// The sanitiser sits in front of the canned answers too, so an over-eager rule there would
// quietly rewrite the store's own FAQ. This is the check that catches that.
const faqService = (await import('./services/faq.js')).default;
let faqAltered = 0;
for (const entry of faqService.getFAQs()) {
  for (const key of ['answer', 'answerTanglish']) {
    if (entry[key] && aiService.sanitizeOutgoing(entry[key]) !== entry[key]) {
      faqAltered++;
      console.log(`       altered: ${entry.category}.${key}`);
    }
  }
}
check('the sanitiser leaves every FAQ answer exactly as written', faqAltered === 0, `${faqAltered} altered`);

// The system prompt is not customer-facing, but the banned-word list inside it must match
// the detector, or the model is told one thing and judged by another.
const tanglishPrompt = aiService.generateSystemPrompt({ language: 'tanglish', cart: [], address: null });
check('the prompt carries the Tanglish safe-word list', /TANGLISH WORDS YOU MAY USE/.test(tanglishPrompt));
check('the prompt tells the model to fall back to English when unsure', /use the plain English word instead/i.test(tanglishPrompt));
check('the English prompt does NOT carry the Tanglish rules (they are a per-language cost)',
  !/TANGLISH WORDS YOU MAY USE/.test(aiService.generateSystemPrompt({ language: 'english', cart: [], address: null })));
check('both prompts carry the message-format rule',
  /MESSAGE FORMAT/.test(tanglishPrompt) && /MESSAGE FORMAT/.test(aiService.generateSystemPrompt({ language: 'english', cart: [], address: null })));

/* ───────────────────────────── 7. "Which teams do you have?" ───────────────────────── */

section('7. "Enna enna team la iruke?" is answered from the catalogue');

const teams = woocommerceService.listTeams();
check('the catalogue yields a team list', teams.length > 0, JSON.stringify(teams));
check('...containing real clubs', teams.some(t => /real madrid/i.test(t)) && teams.some(t => /barcelona/i.test(t)), JSON.stringify(teams));
check('...and no print-style categories (RN:HS, CLR:FS, 5-SLV)',
  !teams.some(t => /^(rn|clr)\s*:|slv/i.test(t)), JSON.stringify(teams));
check('...and no merchandising categories (Signature Embroidery, Kids)',
  !teams.some(t => /signature embroidery|^kids$|limited time drop/i.test(t)), JSON.stringify(teams));
check('...normalised to one consistent casing', teams.every(t => t === woocommerceService.titleCaseTeam(t)), JSON.stringify(teams));

const RANGE_QUESTIONS = ['Enna enna team la iruke', 'what teams do you have', 'which clubs are available bro', 'list of teams'];
for (const q of RANGE_QUESTIONS) {
  check(`recognised as a range question: "${q}"`, woocommerceService.asksWhichTeams(q));
}
const NOT_RANGE = ['Real Madrid jersey iruka bro', 'Barcelona team jersey venum', 'M size 2', 'yes'];
for (const q of NOT_RANGE) {
  check(`NOT treated as a range question: "${q}"`, !woocommerceService.asksWhichTeams(q));
}

/* ──────────────── 7b. A query that names nothing is not a confident match ──────────── */

section('7b. "3 jersey venum" names nothing to match on');

// The substring rule used to match the whole catalogue on the word "JERSEY" in every product
// name, score all 136 shirts identically and label them 'exact' -- so "Yennaku 3 jersey venum"
// was answered "Bro kandippa iruku!" ("we definitely have it!") over three unrelated shirts.
const BROAD = ['jersey', 'jerseys', '3 jersey venum', 'Yennaku 3 jersey venum', 'jerseys venum bro'];
for (const q of BROAD) {
  const r = woocommerceService.searchProductsDetailed(q);
  check(`"${q}" is 'broad', not 'exact'`, r.matchQuality === 'broad', r.matchQuality);
  check(`...and returns no products to present as a match ("${q}")`, r.products.length === 0, `${r.products.length} products`);
}

// Everything that DOES carry a real angle must keep working -- 'broad' is a narrow gate, and
// widening it by accident would silently disable budget, cheapest and season searches.
const STILL_SEARCHES = [
  ['real madrid', 'a team name'],
  ['jerseys under 700', 'a price limit'],
  ['cheapest jersey', 'a cheapest search'],
  ['best selling jersey', 'a bestseller search'],
  ['kids jersey', 'a kids search'],
  ['26/27 jersey', 'a season'],
];
for (const [q, why] of STILL_SEARCHES) {
  const r = woocommerceService.searchProductsDetailed(q);
  check(`${why} still searches normally ("${q}")`, r.matchQuality !== 'broad' && r.products.length > 0, `${r.matchQuality}/${r.products.length}`);
}

/* ─────────────── 7c. The bot must not offer teams the shop does not carry ───────────── */

section('7c. Teams we do not stock are never offered');

// Seen twice in production: "IPL team ah irundha CSK, Mumbai Indians, Rajasthan Royals kooda
// iruku" (2026-09-21) and "say PSG, Real Madrid, Inter Milan" (2026-09-22, after the first
// round of fixes). NEVER INVENT PRODUCTS covers naming a product; this covers sending the
// customer off to ask for a club that will never arrive.
check('PSG and Inter Milan are caught',
  JSON.stringify(woocommerceService.unstockedTeamsMentioned('say PSG, Real Madrid, Inter Milan').sort()) === '["inter milan","psg"]',
  JSON.stringify(woocommerceService.unstockedTeamsMentioned('say PSG, Real Madrid, Inter Milan')));
check('Rajasthan Royals is caught',
  woocommerceService.unstockedTeamsMentioned('CSK, Mumbai Indians, Rajasthan Royals kooda iruku').includes('rajasthan royals'));
check('...and CSK is NOT, because we really stock it',
  !woocommerceService.unstockedTeamsMentioned('CSK and Chennai Super Kings jerseys iruku').includes('chennai super kings'));
check('...and neither is Mumbai Indians, which is in the catalogue (out of stock, but real)',
  !woocommerceService.unstockedTeamsMentioned('Mumbai Indians jersey').includes('mumbai indians'));
check('"AC Milan" does not make "Inter Milan" look stocked',
  woocommerceService.unstockedTeamsMentioned('We have AC Milan and Inter Milan').includes('inter milan'));
check('a reply naming only real teams is clean',
  woocommerceService.unstockedTeamsMentioned('Real Madrid, FC Barcelona, AC Milan, Chelsea, Liverpool, Arsenal').length === 0,
  JSON.stringify(woocommerceService.unstockedTeamsMentioned('Real Madrid, FC Barcelona, AC Milan, Chelsea, Liverpool, Arsenal')));
check('the bot\'s own team list passes its own check',
  woocommerceService.unstockedTeamsMentioned(aiService.teamListReply('english')).length === 0,
  JSON.stringify(woocommerceService.unstockedTeamsMentioned(aiService.teamListReply('english'))));
check('an empty reply flags nothing', woocommerceService.unstockedTeamsMentioned('').length === 0);

/* ───────────────────────────── 8. The egress, end to end ───────────────────────────── */

section('8. answerQuery cleans every path, with a stubbed LLM');

// Force the agentic loop down the free-text branch and hand it the exact broken content
// from the live chat. node --check cannot see this wiring -- only executing it proves the
// egress wrapper is actually in the call path.
const stubbedCompletion = (content) => ({
  choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});

const originalCall = aiService.callLLMWithRetry.bind(aiService);
const originalFallback = aiService.getFallbackEntries?.bind(aiService);

async function replyWithStub(senderId, query, content) {
  aiService.callLLMWithRetry = async () => stubbedCompletion(content);
  try {
    return await aiService.answerQuery(senderId, query);
  } finally {
    aiService.callLLMWithRetry = originalCall;
  }
}

const SENDER = '919000000001@c.us';
await dbService.saveSession(SENDER, {
  state: 'IDLE', cart: [], address: null, history: [], language: 'tanglish',
  lastShownProducts: [], firstContactLogged: true,
});

const leaked = await replyWithStub(SENDER, 'chelsea jersey venum bro', LIVE_ESCAPE);
check('a leak in the LLM reply never reaches the customer',
  !/[\\{}]/.test(leaked.replyText), leaked.replyText);

await dbService.saveSession(SENDER, {
  state: 'IDLE', cart: [], address: null, history: [], language: 'tanglish',
  lastShownProducts: [], firstContactLogged: true,
});
const asterisked = await replyWithStub(SENDER, 'arsenal jersey venum bro', LIVE_ASTERISK);
check('a mid-word markdown marker never reaches the customer',
  !/kaanpida\*ven/.test(asterisked.replyText), asterisked.replyText);

await dbService.saveSession(SENDER, {
  state: 'IDLE', cart: [], address: null, history: [], language: 'tanglish',
  lastShownProducts: [], firstContactLogged: true,
});
const allGarbage = await replyWithStub(SENDER, 'juventus jersey venum bro', '{"type":"function","name":"search_products","parameters":{"query":"juventus"}}');
check('a reply that is entirely a leak becomes an honest apology, not blank',
  allGarbage.replyText.trim().length > 20 && !aiService.looksCorrupted(allGarbage.replyText), allGarbage.replyText);
check('...and that apology is in the session language', /bro/i.test(allGarbage.replyText), allGarbage.replyText);

// The unstocked-team guard, driven through the real loop: the model offers PSG twice, so the
// nudge fires and then the deterministic team list replaces the answer.
await dbService.saveSession(SENDER, {
  state: 'IDLE', cart: [], address: null, history: [], language: 'english',
  lastShownProducts: [], firstContactLogged: true,
});
let nudgedAboutTeams = false;
aiService.callLLMWithRetry = async (messages) => {
  if (messages.some(m => m.role === 'system' && /teams we do NOT stock/i.test(m.content || ''))) {
    nudgedAboutTeams = true;
  }
  return stubbedCompletion('Sure! Try PSG, Inter Milan or Napoli — which one?');
};
const offeredUnstocked = await aiService.answerQuery(SENDER, 'what do you have');
aiService.callLLMWithRetry = originalCall;
check('offering unstocked teams triggers a rewrite', nudgedAboutTeams, 'the model was never nudged');
check('...and PSG never reaches the customer', !/psg/i.test(offeredUnstocked.replyText), offeredUnstocked.replyText.slice(0, 200));
check('...and the customer gets the real team list instead', /Real Madrid/i.test(offeredUnstocked.replyText), offeredUnstocked.replyText.slice(0, 200));

// The two deterministic paths added for this report -- no LLM is reachable from here, so a
// stub is not even needed. If either regressed into the LLM path, the intent tag changes.
await dbService.saveSession(SENDER, {
  state: 'IDLE', cart: [], address: null, history: [], language: 'tanglish',
  lastShownProducts: [], firstContactLogged: true,
});
const teamsReply = await aiService.answerQuery(SENDER, 'Enna enna team la iruke');
check('"which teams?" is answered deterministically', teamsReply.intent === 'deterministic_teams', teamsReply.intent);
// Asked twice in a row, it must point back at the list rather than reprinting twelve lines.
const teamsAgain = await aiService.answerQuery(SENDER, 'what teams do you have');
check('...and asking again does not reprint the whole list', teamsAgain.replyText !== teamsReply.replyText, teamsAgain.replyText.slice(0, 120));
check('...but still tells them what to do next', /Real Madrid/i.test(teamsAgain.replyText), teamsAgain.replyText.slice(0, 160));
check('...with real catalogue teams', /Real Madrid/i.test(teamsReply.replyText), teamsReply.replyText.slice(0, 200));
check('...and not with teams we do not stock (CSK / Mumbai Indians / Mbappe)',
  !/(mumbai indians|rajasthan royals|mbappe|haaland)/i.test(teamsReply.replyText), teamsReply.replyText.slice(0, 250));
check('...in clean Tanglish', aiService.tanglishProblems(teamsReply.replyText, 'tanglish').length === 0, teamsReply.replyText.slice(0, 200));

await dbService.saveSession(SENDER, {
  state: 'IDLE', cart: [], address: null, history: [], language: 'tanglish',
  lastShownProducts: [], firstContactLogged: true,
});
const confused = await aiService.answerQuery(SENDER, 'Enna bro pesuradhe purila');
check('"I don\'t understand you" gets a deterministic plain-language recovery',
  confused.intent === 'deterministic_clarify', confused.intent);
check('...that does not answer with another bare question', /Real Madrid/i.test(confused.replyText), confused.replyText.slice(0, 200));
check('...and adds no further invented Tamil', aiService.tanglishProblems(confused.replyText, 'tanglish').length === 0, confused.replyText.slice(0, 200));

if (originalFallback) aiService.getFallbackEntries = originalFallback;

/* ───────────────────────────── 9. Tool list stays in sync ───────────────────────────── */

section('9. The sanitiser knows about every registered tool');

const registered = aiService.getTools().map(t => t.function.name).sort();
const known = aiService.toolNames().slice().sort();
check('toolNames() covers getTools() exactly',
  JSON.stringify(registered) === JSON.stringify(known),
  `registered=${JSON.stringify(registered)} known=${JSON.stringify(known)}`);

/* ───────────────────────────── summary ───────────────────────────── */

try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);

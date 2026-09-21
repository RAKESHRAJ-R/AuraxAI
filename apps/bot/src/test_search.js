/**
 * Product-search regression suite — `npm run test-search`.
 *
 * Every case here comes from the tester reviews of 2026-09-20, where the bot answered a
 * question it could not answer by quietly substituting something else:
 *
 *   "Real Madrid 26/27 all kit jerseys" -> REAL MADRID 14-15 / 17-18 / 11-12   (season ignored)
 *   "Player version 26/27"              -> CSK 2025 ₹350, RCB 2026 ₹360       (cheapest filler)
 *   "Ac Milan jerseys iruka bro?"       -> "Can you be more Specific"          (never searched)
 *
 * Four causes, all covered below: seasons were dropped as numeric tokens before scoring; a
 * zero-result search returned the five cheapest in-stock products labelled "Found products";
 * the hype opener was printed unconditionally over whatever came back; and the team was lost
 * between turns, so a follow-up that only narrowed searched with nothing to narrow.
 *
 * Runs against the real product cache and nothing else — no LLM, no network, no database, no
 * WhatsApp session. It asserts on SHAPE (is the team right, was the missed constraint
 * reported) rather than on exact product names, so a catalogue refresh does not break it.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

// Keep db.js off live data — ai.js pulls it in transitively.
process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-search-'));

const woo = (await import('./services/woocommerce.js')).default;
const aiService = (await import('./services/ai.js')).default;

let passed = 0;
let failed = 0;

const check = (name, condition, detail = '') => {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`);
  }
};

const names = (list) => list.map(p => p.name).join(' | ') || '(none)';
const every = (list, re) => list.length > 0 && list.every(p => re.test(p.name));
const none = (list, re) => !list.some(p => re.test(p.name));

console.log('\n=== Product search regression suite ===\n');

const cache = woo.getLocalProducts();
if (!cache || cache.length === 0) {
  console.error('No product cache found. Run `npm run sync` first.');
  process.exit(1);
}
console.log(`Cache: ${cache.length} products\n`);

// ---------------------------------------------------------------- 1. season parsing
console.log('1. Season parsing');
{
  const s1 = woo.parseSeasons('Real Madrid 26/27 all kit jerseys');
  check('"26/27" is seen at all', s1.present, 'a season used to be dropped by the isNaN token filter');
  check('"26/27" canonicalises to 26/27', s1.canonical.has('26/27'), [...s1.canonical].join(','));

  const s2 = woo.parseSeasons('AC MILAN 1996-97 HOME');
  check('"1996-97" canonicalises to 96/97', s2.canonical.has('96/97'), [...s2.canonical].join(','));

  const s3 = woo.parseSeasons('ARGENTINA 2026 WORLD CUP');
  check('a bare "2026" is a season', s3.canonical.has('26'), [...s3.canonical].join(','));

  const s4 = woo.parseSeasons('2026-2027 kit');
  check('"2026-2027" matches "26/27"', s4.canonical.has('26/27'), [...s4.canonical].join(','));

  check('a price is not a season', !woo.parseSeasons('jerseys under 700').present);
  check('a pincode is not a season', !woo.parseSeasons('my pincode is 600028').present);

  const q = woo.parseSeasons('26/27');
  check('26/27 does NOT match a 25-26 shirt', !woo.seasonMatches(q, woo.parseSeasons('REAL MADRID 25-26 THIRD')));
  check('26/27 DOES match a 2026 shirt', woo.seasonMatches(q, woo.parseSeasons('GERMANY 2026 WORLD CUP HOME')));
}

// ---------------------------------------------------------------- 2. tester review #1
console.log('\n2. Review: "Real Madrid 26/27 all kit jerseys"');
{
  const r = woo.searchProductsDetailed('Real Madrid 26/27 all kit jerseys');
  check('returns Real Madrid and nothing else', every(r.products, /REAL MADRID/i), names(r.products.slice(0, 5)));
  check('no unrelated team sneaks in on the season', none(r.products, /RCB|CHENNAI|SPAIN|GERMANY|ROYAL CHALLENGERS/i), names(r.products.slice(0, 5)));
  check('reported as a PARTIAL match, not a hit', r.matchQuality === 'partial', `got ${r.matchQuality}`);
  check('names 26/27 as the thing we lack', r.unmatched.includes('26/27'), JSON.stringify(r.unmatched));
  const top = r.products[0];
  check('leads with the newest season we do stock', top && woo.seasonRecency(top) >= 2025, top ? `${top.name} -> ${woo.seasonRecency(top)}` : 'no products');
}

// ---------------------------------------------------------------- 3. tester review #2
console.log('\n3. Review: "Player version 26/27" as a follow-up');
{
  check('"Player version 26/27" carries no subject of its own', woo.extractSubject('Player version 26/27') === null);
  check('"Real Madrid 26/27..." yields the team as subject', woo.extractSubject('Real Madrid 26/27 all kit jerseys') === 'real madrid');

  // The conversation: ask about Real Madrid, then narrow.
  const session = {};
  aiService._mergeSearchContext(session, 'Real Madrid 26/27 all kit jerseys');
  const merged = aiService._mergeSearchContext(session, 'Player version 26/27');
  check('the team is carried into the follow-up', /real madrid/i.test(merged), merged);

  const r = woo.searchProductsDetailed(merged);
  check('follow-up still returns Real Madrid', every(r.products, /REAL MADRID/i), names(r.products.slice(0, 5)));
  check('no cheapest-filler IPL shirt', none(r.products, /CSK|RCB|CHENNAI SUPER|ROYAL CHALLENGERS/i), names(r.products.slice(0, 5)));
  check('Player Version is reported as unavailable', r.unmatched.includes('Player Version'), JSON.stringify(r.unmatched));

  // A new team replaces the old subject rather than stacking onto it.
  const after = aiService._mergeSearchContext(session, 'chelsea jersey');
  check('a new team replaces the carried subject', !/real madrid/i.test(after), after);
}

// ---------------------------------------------------------------- 4. tester review #3
console.log('\n4. Review: "Ac Milan jerseys iruka bro?"');
{
  const r = woo.searchProductsDetailed('Ac Milan jerseys iruka bro');
  check('AC Milan is found', r.products.length > 0, names(r.products.slice(0, 3)));
  // Every hit must be AC Milan by NAME or by CATEGORY. One published product --
  // "FC BARCELONA X ED SHEERAN 25-26 HOME" -- genuinely carries an "AC Milan" category in
  // WooCommerce, so matching it is the search being right about wrong data. That is a
  // catalogue fix in wp-admin, not a scoring bug, and the assertion says so rather than
  // being loosened until it passes.
  const isMilan = p => /AC MILAN/i.test(p.name) || (p.categories || []).some(c => /ac milan/i.test(c));
  check('every result is AC Milan by name or category', r.products.length > 0 && r.products.every(isMilan), names(r.products));
  check('the top 5 are AC Milan by name', every(r.products.slice(0, 5), /AC MILAN/i), names(r.products.slice(0, 5)));
  check('reported as an exact match', r.matchQuality === 'exact', `got ${r.matchQuality}`);
  check('recognised as a product question (so the agent must search before clarifying)', woo.looksLikeProductQuery('Ac Milan jerseys iruka bro'));
  check('small talk is NOT a product question', !woo.looksLikeProductQuery('ok thanks bro'));
  check('an address is NOT a product question', !woo.looksLikeProductQuery('my pincode is 600028'));
}

// ---------------------------------------------------------------- 5. no silent substitution
console.log('\n5. A miss is reported as a miss');
{
  const r = woo.searchProductsDetailed('zzzqwerty unicorn jersey');
  check('no products are claimed', r.products.length === 0, names(r.products));
  check('matchQuality is none', r.matchQuality === 'none', `got ${r.matchQuality}`);
  check('suggestions are kept in a SEPARATE field', Array.isArray(r.suggestions), 'they used to be returned as matches');
  check('the array API returns [] rather than filler', woo.searchProducts('zzzqwerty unicorn jersey').length === 0);

  const msg = aiService._searchResultMessage(r, 'zzzqwerty unicorn jersey');
  check('the model is told NO MATCH, not "Found products"', /NO MATCH/.test(msg) && !/^Found products/.test(msg), msg.slice(0, 70));

  const partial = woo.searchProductsDetailed('Real Madrid 26/27');
  const pmsg = aiService._searchResultMessage(partial, 'Real Madrid 26/27');
  check('a partial match is announced as partial', /PARTIAL MATCH/.test(pmsg), pmsg.slice(0, 70));
  check('the partial message names what is missing', /26\/27/.test(pmsg), pmsg.slice(0, 90));

  const exact = woo.searchProductsDetailed('Ac Milan jerseys');
  check('an exact match still reads as found', /^Found products/.test(aiService._searchResultMessage(exact, 'Ac Milan jerseys')));
}

// ---------------------------------------------------------------- 6. season filter works
console.log('\n6. A season we DO stock filters correctly');
{
  const r = woo.searchProductsDetailed('Real Madrid 25-26');
  check('finds the 25-26 Real Madrid kits', r.products.length > 0, names(r.products));
  check('every result is Real Madrid', every(r.products, /REAL MADRID/i), names(r.products));
  check('every result is the requested season', every(r.products, /25-26|25\/26|2025|2026/i), names(r.products));
  check('reported as exact, nothing unmatched', r.matchQuality === 'exact' && r.unmatched.length === 0, `${r.matchQuality} ${JSON.stringify(r.unmatched)}`);
}

// ---------------------------------------------------------------- 7. ordinary searches
console.log('\n7. Unconstrained searches are unaffected');
{
  const messi = woo.searchProductsDetailed('messi jersey');
  check('a plain player search still works', messi.products.length > 0 && messi.matchQuality === 'exact', names(messi.products.slice(0, 3)));

  const cheap = woo.searchProductsDetailed('cheapest jersey');
  check('"cheapest" still returns something', cheap.products.length > 0, names(cheap.products.slice(0, 2)));

  const best = woo.searchProductsDetailed('best selling jerseys');
  check('"best selling" still returns something', best.products.length > 0, names(best.products.slice(0, 2)));

  const budget = woo.searchProductsDetailed('jerseys under 400');
  check('a budget query respects the limit', budget.products.length > 0 && budget.products.every(p => parseFloat(p.price) <= 400), names(budget.products.slice(0, 3)));
}

// ---------------------------------------------------------------- 8. bare constraints
console.log('\n8. A constraints-only question');
{
  const r = woo.searchProductsDetailed('do you have any 25-26 kits');
  check('a bare season query finds that season', r.products.length > 0, names(r.products.slice(0, 3)));
  check('and returns only that season', every(r.products, /25-26|25\/26|2025|2026/i), names(r.products.slice(0, 5)));

  const impossible = woo.searchProductsDetailed('do you have any 1975-76 kits');
  check('an unstocked bare season does NOT return the whole catalogue', impossible.products.length === 0, `${impossible.products.length} products`);
  check('...and is reported as no match', impossible.matchQuality === 'none', `got ${impossible.matchQuality}`);
}

// ---------------------------------------------------------------- 9. the agent path
// These drive the real search_products tool handler inside answerQuery with a stubbed LLM,
// so the reply the customer would actually receive is asserted rather than just the search
// result. They also execute that handler, which `node --check` cannot: a missed edit there
// leaves a ReferenceError that only shows up on a live customer message.
console.log('\n9. The reply the customer actually gets');
{
  const dbService = (await import('./services/db.js')).default;
  const faqService = (await import('./services/faq.js')).default;

  let session = {};
  dbService.getSession = async () => session;
  dbService.saveSession = async (id, s) => { session = s; };
  dbService.saveLead = async () => {};
  dbService.getKnowledgeEntries = async () => [];
  faqService.findAnswer = () => null;

  // One canned LLM turn: "call search_products with this query", then stop.
  const stubLLM = (query) => {
    let called = 0;
    aiService.callLLMWithFallback = async () => {
      called++;
      if (called === 1) {
        return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'search_products', arguments: JSON.stringify({ query }) } }] } }] };
      }
      return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
    };
  };

  session = { state: 'IDLE', language: 'english', cart: [], history: [], firstContactLogged: true };
  stubLLM('Ac Milan jerseys');
  const exact = await aiService.answerQuery('91777@c.us', 'Ac Milan jerseys iruka bro');
  check('an exact match reaches the customer with products', /AC MILAN/i.test(exact.replyText), exact.replyText.slice(0, 120));

  session = { state: 'IDLE', language: 'english', cart: [], history: [], firstContactLogged: true };
  stubLLM('Real Madrid 26/27 all kit jerseys');
  const partial = await aiService.answerQuery('91777@c.us', 'Real Madrid 26/27 all kit jerseys');
  check('a partial match says what we do NOT have', /don't have 26\/27/i.test(partial.replyText), partial.replyText.slice(0, 160));
  check('...and does not open with hype', !/(Great pick|Yes, we have it|Semma choice|kandippa iruku)/i.test(partial.replyText), partial.replyText.slice(0, 160));
  check('...and still offers real Real Madrid shirts', /REAL MADRID/i.test(partial.replyText));

  session = { state: 'IDLE', language: 'english', cart: [], history: [], firstContactLogged: true };
  stubLLM('zzzqwerty unicorn jersey');
  const miss = await aiService.answerQuery('91777@c.us', 'zzzqwerty unicorn jersey');
  check('a miss is admitted to the customer', /couldn't find an exact match/i.test(miss.replyText), miss.replyText.slice(0, 160));
  check('...and is not dressed up as a find', !/(Great pick|Yes, we have it|This one's a favorite)/i.test(miss.replyText), miss.replyText.slice(0, 160));

  // The model tries to clarify without searching: the guard must force a search instead.
  session = { state: 'IDLE', language: 'english', cart: [], history: [], firstContactLogged: true };
  let turn = 0;
  let forced = false;
  aiService.callLLMWithFallback = async (messages) => {
    turn++;
    if (turn === 1) return { choices: [{ message: { role: 'assistant', content: 'Can you be more specific?' } }] };
    forced = messages.some(m => m.role === 'system' && /without searching first/i.test(m.content || ''));
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'search_products', arguments: JSON.stringify({ query: 'Ac Milan jerseys' }) } }] } }] };
  };
  const clarified = await aiService.answerQuery('91777@c.us', 'Ac Milan jerseys iruka bro');
  check('"be more specific" without a search is caught and retried', forced, 'the model was not nudged to search');
  check('...and the customer gets products instead', /AC MILAN/i.test(clarified.replyText), clarified.replyText.slice(0, 120));
}

// ---------------------------------------------------------------- summary
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);

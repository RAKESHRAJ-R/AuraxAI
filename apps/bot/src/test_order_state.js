/**
 * Order-state regression suite — `npm run test-order-state`.
 *
 * Reproduces the 2026-09-22 production chat (customer picked the FC Barcelona 2009 Messi
 * shirt, the bot carted the 1899-1999 Guardiola one at qty 2, re-asked for an address the
 * customer had already sent, then threw them back to "Enna team venum?") and the ten
 * scenarios written up from it.
 *
 * Runs the REAL answerQuery pipeline against the real JSON session store in a throwaway
 * directory (so the optimistic-version code is exercised too), the real product cache, and
 * a scripted fake LLM. Nothing is sent, no order is placed, no network call is made.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-orderstate-'));
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-dummy-key';

const config = (await import('./config/config.js')).default;
const woo = (await import('./services/woocommerce.js')).default;
const dbService = (await import('./services/db.js')).default;
const whatsappWebBot = (await import('./services/whatsapp-web-bot.js')).default;
const knowledgeService = (await import('./services/knowledge.js')).default;
const retrievalService = (await import('./services/retrieval.js')).default;
const sheetsService = (await import('./services/sheets.js')).default;
const aiService = (await import('./services/ai.js')).default;
const orderState = (await import('./services/orderState.js')).default;

let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- environment
whatsappWebBot.status = 'DISCONNECTED';
whatsappWebBot.client = null;
whatsappWebBot.sendText = async () => {};
sheetsService.appendRow = async () => {};
knowledgeService.match = async () => null;
retrievalService.buildContextMessage = async () => null;
config.owner.whatsappNumber = '';
config.payment = { codEnabled: false, gateway: 'Razorpay', methods: ['UPI', 'Debit/Credit card', 'Net banking'] };

// Scripted LLM: each test queues responses. Any call beyond the script is a failure signal.
let llmScript = [];
let llmCalls = 0;
aiService.callLLMWithFallback = async () => {
  llmCalls++;
  const next = llmScript.shift();
  if (!next) return { choices: [{ message: { role: 'assistant', content: 'Sure bro, sollunga!' } }] };
  return { choices: [{ message: next }] };
};
const toolCall = (name, args) => ({
  role: 'assistant', content: '',
  tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const say = (text) => ({ role: 'assistant', content: text });

// The real catalogue — these two are the products from the production chat.
const products = woo.getLocalProducts();
const GUARDIOLA = products.find(p => /1899-1999 HOME — PEP GUARDIOLA/.test(p.name));
const MESSI = products.find(p => /2009 FINAL HOME FULL SLEEVE — MESSI/.test(p.name));
if (!GUARDIOLA || !MESSI) {
  console.error('Test fixtures missing from the product cache (Guardiola / Messi 2009).');
  process.exit(1);
}
const shown = [GUARDIOLA, MESSI, products.find(p => /FC BARCELONA 14-15 HOME/.test(p.name)) || GUARDIOLA]
  .map(p => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: p.permalink || '' }));

let n = 0;
const newCustomer = async (overrides = {}) => {
  const id = `9190000000${String(++n).padStart(2, '0')}@c.us`;
  const s = await dbService.getSession(id);
  Object.assign(s, {
    language: 'tanglish', firstContactLogged: true, history: [], cart: [],
    lastShownProducts: shown, productListPending: true, state: 'IDLE',
  }, overrides);
  await dbService.saveSession(id, s);
  llmScript = [];
  llmCalls = 0;
  return id;
};
const ask = (id, text) => aiService.answerQuery(id, text, 'PRANAV', null);
const state = (id) => dbService.getSession(id);

const ADDRESS_MSG = 'Name:\nPRANAV\n\nAddress:\nNo.38, Ishwaryam flats D block G1,\nMylappa Street,\nAyanavaram,\nChennai - 600023\n\nPincode:\n600023\n\nMobile:\n9361475788';
const TEAM_LIST = /Idhellaam ippo stock la iruku|Enna team venum|Which team would you like/i;

console.log('\n=== Order-state regression suite ===\n');

// ---------------------------------------------------------------- the production chat
console.log('0. The production chat, replayed');
{
  const id = await newCustomer();
  let r = await ask(id, '2');
  check('"2" selects product #2 (Messi)', (await state(id)).selectedProduct?.productId === MESSI.id, r.replyText);
  r = await ask(id, '2 and one quantity and m size');
  let s = await state(id);
  check('product is STILL Messi (not Guardiola)', s.cart[0]?.productId === MESSI.id, JSON.stringify(s.cart));
  check('size is M', s.cart[0]?.size === 'M', JSON.stringify(s.cart));
  check('quantity is 1 ("one quantity"), not 2', s.cart[0]?.qty === 1, JSON.stringify(s.cart));
  check('no LLM call was needed', llmCalls === 0, `llmCalls=${llmCalls}`);
  r = await ask(id, ADDRESS_MSG);
  s = await state(id);
  check('address captured in structured fields', s.addressDetails?.pincode === '600023' && s.addressDetails?.phone === '9361475788' && /PRANAV/i.test(s.addressDetails?.name || ''), JSON.stringify(s.addressDetails));
  check('moves to CART_REVIEW with a summary', s.state === 'CONFIRMING_ORDER' && /MESSI/.test(r.replyText) && /YES/.test(r.replyText), r.replyText);
  check('summary does not mention Guardiola', !/GUARDIOLA/i.test(r.replyText), r.replyText);
  r = await ask(id, 'Already send paniten');
  check('"already send paniten" does not ask for the address again', !/(pincode|mobile number|shipping details)\s*(sollunga|anuppunga|share)/i.test(r.replyText) && /YES/.test(r.replyText), r.replyText);
  check('never falls back to the team list', !TEAM_LIST.test(r.replyText), r.replyText);
}

// ---------------------------------------------------------------- TEST 1
console.log('\n1. Select Barcelona 2009 Messi → "M" → "1"');
{
  const id = await newCustomer();
  await ask(id, '2');
  let r = await ask(id, 'M');
  check('"M" asks only for the quantity', /quantity/i.test(r.replyText) && !/size venum/i.test(r.replyText), r.replyText);
  r = await ask(id, '1');
  const s = await state(id);
  check('same product', s.cart[0]?.productId === MESSI.id, JSON.stringify(s.cart));
  check('size M, qty 1', s.cart[0]?.size === 'M' && s.cart[0]?.qty === 1, JSON.stringify(s.cart));
}

// ---------------------------------------------------------------- TEST 2
console.log('\n2. Product selected (address on file from before) → "already send paniten"');
{
  const id = await newCustomer({
    customerProfile: { name: 'PRANAV', phone: '9361475788', address: 'No.38, Ishwaryam flats D block G1, Mylappa Street, Ayanavaram, Chennai', pincode: '600023' },
  });
  await ask(id, '2');
  let r = await ask(id, 'M 1');
  check('with an address on file, carting goes straight to the summary', /YES/.test(r.replyText) && !/Pincode, Mobile/i.test(r.replyText), r.replyText);
  r = await ask(id, 'already send paniten');
  const s = await state(id);
  check('existing address is used', s.addressDetails?.pincode === '600023', JSON.stringify(s.addressDetails));
  check('not asked for the address again', !/(send|share|sollunga|anuppunga)[^.]*(address|pincode|mobile)/i.test(r.replyText), r.replyText);
}

// ---------------------------------------------------------------- TEST 3
console.log('\n3. Product A locked → the model tries to cart product B');
{
  const id = await newCustomer();
  await ask(id, '2'); // Messi locked
  // The LLM "helpfully" runs a search and carts the top hit (Guardiola) for "M size bro, fast ah".
  llmScript = [toolCall('update_cart', { productId: GUARDIOLA.id, name: GUARDIOLA.name, price: Number(GUARDIOLA.price), size: 'M', qty: 2 })];
  await ask(id, 'medium size venum bro, fast ah anuppunga please, romba urgent');
  const s = await state(id);
  check('product remains A (Messi)', s.cart[0]?.productId === MESSI.id || s.selectedProduct?.productId === MESSI.id, JSON.stringify(s.cart));
  check('Guardiola never reached the cart', !(s.cart || []).some(i => i.productId === GUARDIOLA.id), JSON.stringify(s.cart));
  check('the model\'s invented qty 2 was not applied', !(s.cart || []).some(i => i.qty === 2), JSON.stringify(s.cart));

  // A search mid-order must not touch the lock either.
  const before = JSON.stringify(s.cart);
  llmScript = [toolCall('search_products', { query: 'barcelona' })];
  await ask(id, 'vera barcelona options iruka?');
  const s2 = await state(id);
  check('a mid-order search leaves the cart untouched', JSON.stringify(s2.cart) === before, `${before} → ${JSON.stringify(s2.cart)}`);
}

// ---------------------------------------------------------------- TEST 4
console.log('\n4. "Barcelona" → "2" → "M" (quantity asked separately)');
{
  const id = await newCustomer({ lastShownProducts: [], productListPending: false });
  llmScript = [toolCall('search_products', { query: 'Barcelona' })];
  let r = await ask(id, 'Barcelona');
  let s = await state(id);
  check('a numbered list is shown', s.lastShownProducts.length >= 2 && /1\./.test(r.replyText), r.replyText);
  r = await ask(id, '2');
  s = await state(id);
  check('"2" selects the second listed product', s.selectedProduct?.productId === s.lastShownProducts[1].productId, JSON.stringify(s.selectedProduct));
  const pickedName = s.selectedProduct?.name || '';
  check('the product is a Barcelona one', /BARCELONA/i.test(pickedName), pickedName);
  r = await ask(id, 'M');
  r = await ask(id, '2');
  s = await state(id);
  check('size M, qty 2, same product', s.cart[0]?.size === 'M' && s.cart[0]?.qty === 2 && s.cart[0]?.name === pickedName, JSON.stringify(s.cart));
}

// ---------------------------------------------------------------- TEST 5
console.log('\n5. Quantity already stored → the model tries to ask it again');
{
  const id = await newCustomer();
  await ask(id, '2');
  await ask(id, '2 qty');
  // Model reply that re-asks the quantity: must be rejected, then replaced.
  llmScript = [say('Evlo quantity venum bro?'), say('Evlo quantity venum bro?')];
  const r = await ask(id, 'hmm seri bro, apram?');
  const s = await state(id);
  check('stored qty is 2', s.pendingQty === 2 || s.cart[0]?.qty === 2, JSON.stringify({ p: s.pendingQty, c: s.cart }));
  check('the reply does not ask for the quantity again', !/(evlo|how many|enna)\s*quantity/i.test(r.replyText), r.replyText);
  check('it asks for the size instead', /size/i.test(r.replyText), r.replyText);
}

// ---------------------------------------------------------------- TEST 6
console.log('\n6. Address given in two parts → "already sent"');
{
  const id = await newCustomer();
  await ask(id, '2');
  await ask(id, 'L 1');
  let r = await ask(id, 'Pranav, No.38 Ishwaryam flats, Mylappa Street, Ayanavaram, Chennai');
  check('partial address asks ONLY for what is missing', /pincode/i.test(r.replyText) && /mobile/i.test(r.replyText) && !/\bName\b.*\bAddress\b/.test(r.replyText), r.replyText);
  check('the door number "38" is NOT read as quantity 38', (await state(id)).cart[0]?.qty === 1, JSON.stringify((await state(id)).cart));
  r = await ask(id, '600023 9361475788');
  let s = await state(id);
  check('the two parts are merged into one complete address', orderState.isAddressComplete(s.addressDetails), JSON.stringify(s.addressDetails));
  r = await ask(id, 'already sent');
  s = await state(id);
  check('"already sent" uses the existing address (summary shown)', /YES/.test(r.replyText) && /600023/.test(r.replyText), r.replyText);
}

// ---------------------------------------------------------------- TEST 7
console.log('\n7. Rapid messages: "Barcelona", "2", "M", "1" fired at once');
{
  const id = await newCustomer({ lastShownProducts: [], productListPending: false });
  llmScript = [toolCall('search_products', { query: 'Barcelona' })];
  // Make the LLM slow so, without the per-customer lock, later messages would overtake it.
  const realCall = aiService.callLLMWithFallback;
  aiService.callLLMWithFallback = async (...a) => { await new Promise(r => setTimeout(r, 150)); return realCall(...a); };
  const replies = await Promise.all(['Barcelona', '2', 'M', '1'].map(t => ask(id, t)));
  aiService.callLLMWithFallback = realCall;
  const s = await state(id);
  check('state is in the right order: product #2, M, qty 1', s.cart[0]?.productId === s.lastShownProducts[1]?.productId && s.cart[0]?.size === 'M' && s.cart[0]?.qty === 1, JSON.stringify(s.cart));
  check('every message got its own reply', replies.every(r => r && r.replyText), JSON.stringify(replies.map(r => r?.intent)));
  check('no save was lost to a version conflict', typeof s.stateVersion === 'number' && s.stateVersion >= 5, `stateVersion=${s.stateVersion}`);
}

// ---------------------------------------------------------------- TEST 7b: stale writer
console.log('\n7b. A stale writer cannot overwrite a newer session');
{
  const id = await newCustomer();
  const a = await dbService.getSession(id);
  const b = await dbService.getSession(id);
  a.pendingQty = 1;
  const first = await dbService.saveSession(id, a);
  b.pendingQty = 9;
  const second = await dbService.saveSession(id, b);
  const s = await state(id);
  check('first write succeeds', first === true);
  check('second (stale) write is refused', second === 'conflict', String(second));
  check('the newer value survives', s.pendingQty === 1, String(s.pendingQty));
}

// ---------------------------------------------------------------- TEST 8
console.log('\n8. In CART_REVIEW / payment → "how pay?"');
{
  const id = await newCustomer();
  await ask(id, '2');
  await ask(id, 'M 1');
  await ask(id, ADDRESS_MSG);
  const r = await ask(id, 'how pay?');
  check('payment information is given', /prepaid|payment link/i.test(r.replyText), r.replyText);
  check('COD is not offered', !/COD available|cash on delivery is available/i.test(r.replyText), r.replyText);
  check('only configured methods are named', !/gpay|phonepe|paytm|wallet/i.test(r.replyText), r.replyText);
  check('does NOT return to team selection', !TEAM_LIST.test(r.replyText), r.replyText);
  const r2 = await ask(id, 'COD iruka?');
  check('"COD iruka?" → honest no', /COD kidaiyaathu|not available/i.test(r2.replyText), r2.replyText);
  const s = await state(id);
  check('cart and step are unchanged', s.state === 'CONFIRMING_ORDER' && s.cart[0]?.productId === MESSI.id, `${s.state} ${JSON.stringify(s.cart)}`);
}

// ---------------------------------------------------------------- TEST 9
console.log('\n9. In ADDRESS_COLLECTION → "Barcelona"');
{
  const id = await newCustomer();
  await ask(id, '2');
  await ask(id, 'M 1');
  let r = await ask(id, 'Barcelona');
  let s = await state(id);
  check('asks a clarification question', /change|maathi/i.test(r.replyText) && /YES/.test(r.replyText), r.replyText);
  check('does not restart the flow', !TEAM_LIST.test(r.replyText) && s.cart[0]?.productId === MESSI.id, r.replyText);
  r = await ask(id, 'no');
  s = await state(id);
  check('"no" keeps the order and resumes it', s.cart[0]?.productId === MESSI.id && /Pincode|Mobile|address/i.test(r.replyText), r.replyText);
}

// ---------------------------------------------------------------- TEST 10
console.log('\n10. "Change product"');
{
  const id = await newCustomer();
  await ask(id, '2');
  await ask(id, 'M 1');
  const r = await ask(id, 'Change product');
  const s = await state(id);
  check('the product is unlocked', !s.selectedProduct && s.cart.length === 0, JSON.stringify({ sel: s.selectedProduct, cart: s.cart }));
  check('asks what they want instead', /team|player/i.test(r.replyText), r.replyText);
  llmScript = [toolCall('search_products', { query: 'Real Madrid' })];
  await ask(id, 'Real Madrid');
  const s2 = await state(id);
  check('a new selection is allowed', s2.productListPending === true && s2.lastShownProducts.length > 0, JSON.stringify(s2.lastShownProducts.map(p => p.name)));
}

// ---------------------------------------------------------------- extractor unit checks
console.log('\n11. Tanglish / short-message extraction');
{
  const e = orderState.extractEntities;
  check('"one quantity thaan sonen" → qty 1', e('one quantity thaan sonen', { hasSelection: true }).qty === 1);
  check('"already send paniten bro" → address already given', e('already send paniten bro').addressAlreadyGiven);
  check('"COD iruka?" → payment query', e('COD iruka?').paymentQuery);
  check('"same address" → address already given', e('same address').addressAlreadyGiven);
  check('"I m waiting" does not confidently set a size', !e('I m waiting for reply', { hasSelection: true }).sizeConfident);
  check('"2xl" → XXL, not qty 2', e('2xl', { hasSelection: true, awaiting: 'size_qty' }).size === 'XXL' && e('2xl', { hasSelection: true, awaiting: 'size_qty' }).qty === null);
  check('a phone number is never a quantity', e('9361475788', { hasSelection: true, awaiting: 'qty' }).qty === null);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Understand-first regression suite — `npm run test-understanding`.
 *
 * Replays the 2026-09-29 Tanglish chat and the four screenshots the client sent on
 * 2026-09-30 through the REAL answerQuery pipeline, with the understanding step's verdict
 * scripted (what the model is expected to read from each message) and a scripted agent LLM.
 * What it checks is the half that is code: given the right meaning, does the bot ACT right —
 * cart, address, order number, payment link, delivery days, lists — every time.
 *
 * It also covers the understanding module itself (parsing, the no-tools call, fallback on
 * failure). Whether the real model reads each message correctly is a separate, paid check:
 * `node src/replay_understanding.js` — run only with the owner's OK.
 *
 * Nothing is sent, no order is placed, no network call is made. Temp data dir.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-understand-'));
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-dummy-key';

const config = (await import('./config/config.js')).default;
const woo = (await import('./services/woocommerce.js')).default;
const dbService = (await import('./services/db.js')).default;
const whatsappWebBot = (await import('./services/whatsapp-web-bot.js')).default;
const knowledgeService = (await import('./services/knowledge.js')).default;
const retrievalService = (await import('./services/retrieval.js')).default;
const sheetsService = (await import('./services/sheets.js')).default;
const understandMod = await import('./services/understand.js');
const aiService = (await import('./services/ai.js')).default;

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
config.understand = { enabled: true, maxTokens: 700 };

// The verdict for the next message. Each test sets it right before asking.
let nextVerdict = null;
aiService.understandMessage = async () => nextVerdict;

// Scripted agent LLM, same shape as test_order_state.js.
let llmScript = [];
let llmCalls = 0;
let lastMessages = null;
aiService.callLLMWithFallback = async (messages) => {
  llmCalls++;
  lastMessages = messages;
  const next = llmScript.shift();
  if (!next) return { choices: [{ message: { role: 'assistant', content: 'Sure, sollunga!' } }] };
  return { choices: [{ message: next }] };
};
const toolCall = (name, args) => ({
  role: 'assistant', content: '',
  tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const say = (text) => ({ role: 'assistant', content: text });

const V = (intent, extra = {}) => ({
  intent, topic: 'none', mood: 'fine', questions: [], search: '', category: 'none',
  pick: null, size: null, qty: null, aboutPlacedOrder: false, meaning: '', confidence: 0.9, ...extra,
});

const products = woo.getLocalProducts();
const GUARDIOLA = products.find(p => /1899-1999 HOME — PEP GUARDIOLA/.test(p.name));
const SHEERAN = products.find(p => /ED SHEERAN 25-26 HOME/.test(p.name)) || GUARDIOLA;
if (!GUARDIOLA) { console.error('Fixture missing: Guardiola shirt.'); process.exit(1); }
const item = (p, size = 'M', qty = 1) => ({ productId: p.id, name: p.name, price: p.price, size, qty });
const lockOf = (p) => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: p.permalink || '' });

const PAY_URL = 'https://theaurax.in/checkout/order-pay/77997/?pay_for_order=true&key=wc_order_test';
const ADDRESS = { name: 'PRANAV', address: 'No.38 Mylappa Street, Chennai', pincode: '600023', phone: '9361475788' };

let n = 0;
const newCustomer = async (overrides = {}) => {
  const id = `9180000000${String(++n).padStart(2, '0')}@c.us`;
  const s = await dbService.getSession(id);
  Object.assign(s, {
    language: 'tanglish', firstContactLogged: true, history: [], cart: [], state: 'IDLE',
    lastShownProducts: [], productListPending: false,
  }, overrides);
  await dbService.saveSession(id, s);
  llmScript = [];
  llmCalls = 0;
  return id;
};
const ask = (id, text, verdict) => { nextVerdict = verdict; return aiService.answerQuery(id, text, 'Sessy', null); };
const state = (id) => dbService.getSession(id);
const TEAM_LIST = /Idhellaam ippo stock la iruku|Enna team venum|Which team would you like|Mela iruka list/i;

console.log('\n=== Understand-first regression suite ===\n');

// ---------------------------------------------------------------- 1. after the order
console.log('1. The 2026-09-29 chat — questions right after order #77997 was placed');
{
  const afterOrder = {
    lastOrder: { orderId: 77997, checkoutUrl: PAY_URL, at: Date.now() - 60 * 1000 },
    customerProfile: ADDRESS,
    history: [{ role: 'user', content: 'Yes' }, { role: 'assistant', content: `Super! 🎉 Order #77997 confirm aayiduchu! ${PAY_URL}` }],
  };
  const id = await newCustomer(afterOrder);

  let r = await ask(id, 'Epo delivery aagum?', V('delivery_question', { topic: 'delivery', aboutPlacedOrder: true }));
  check('"Epo delivery aagum?" answers delivery, not the team list', !TEAM_LIST.test(r.replyText) && /5–7/.test(r.replyText), r.replyText);
  check('…about THEIR order #77997', /77997/.test(r.replyText), r.replyText);
  check('…without asking them to order again', !/order place pannuveengala|endha jersey paakureenga/i.test(r.replyText), r.replyText);
  check('…with zero LLM calls', llmCalls === 0, `llmCalls=${llmCalls}`);

  r = await ask(id, 'Delivery Evolo naal agum bro', V('delivery_question', { topic: 'delivery' }));
  check('"Delivery Evolo naal agum bro" (any spelling) answers delivery', /5–7/.test(r.replyText) && !TEAM_LIST.test(r.replyText), r.replyText);

  r = await ask(id, 'Already order placed payment matum pending', V('order_status', { aboutPlacedOrder: true }));
  check('"Already order placed…" confirms order #77997 and gives the link', /77997/.test(r.replyText) && r.replyText.includes(PAY_URL), r.replyText);
  check('…never "once you confirm the order"', !/confirm pannadhum|once you confirm/i.test(r.replyText), r.replyText);
  check('…never read as "I already sent my address"', !/address/i.test(r.replyText), r.replyText);

  r = await ask(id, 'payment eppadi pannanum?', V('payment_question', { topic: 'payment' }));
  check('a payment question after ordering gives the link, not "once you confirm"', r.replyText.includes(PAY_URL) && !/confirm pannadhum/i.test(r.replyText), r.replyText);

  r = await ask(id, 'Okay', V('closing', { mood: 'frustrated' }));
  check('"Okay" from a fed-up customer: a sorry and a close, no team list', /sorry/i.test(r.replyText) && !TEAM_LIST.test(r.replyText), r.replyText);
  r = await ask(id, 'No need', V('closing', { mood: 'frustrated' }));
  check('a second closing message gets a short "Seri 👍", not another speech', r.replyText.trim() === 'Seri 👍', r.replyText);
  check('closing costs no LLM call', llmCalls === 0, `llmCalls=${llmCalls}`);
}

// ---------------------------------------------------------------- 2. screenshot 4
console.log('\n2. Screenshot 4 — delivery asked mid-order (address step)');
{
  const id = await newCustomer({
    cart: [item(SHEERAN)], selectedProduct: lockOf(SHEERAN), state: 'COLLECTING_ADDRESS',
    addressDraft: { name: 'Sessy' },
  });
  const r = await ask(id, 'Evolo naal agum bro jersey varadhuku', V('delivery_question', { topic: 'delivery' }));
  const s = await state(id);
  check('the delivery question is answered', /5–7/.test(r.replyText), r.replyText);
  check('then ONE line brings them back to the order', /anuppunga/.test(r.replyText) && !/Unga cart la .* iruku/.test(r.replyText), r.replyText);
  check('the cart is untouched', s.cart[0]?.productId === SHEERAN.id && s.cart[0]?.qty === 1, JSON.stringify(s.cart));
  check('no trailing "which jersey are you looking at?" mid-order', !/endha jersey paakureenga/i.test(r.replyText), r.replyText);
}

// ---------------------------------------------------------------- 3. screenshots 1-2
console.log('\n3. Screenshots 1–2 — the English customer who wanted out, then Man City');
{
  const confirming = {
    language: 'english', cart: [item(GUARDIOLA)], selectedProduct: lockOf(GUARDIOLA),
    state: 'CONFIRMING_ORDER', addressDetails: ADDRESS, customerProfile: ADDRESS,
  };

  let id = await newCustomer(confirming);
  let r = await ask(id, "Just forget me and my data let's start over",
    V('start_over', { meaning: 'The customer wants their data forgotten and to start over.' }));
  let s = await state(id);
  check('"forget me and my data, start over" (48 chars) empties the cart', s.cart.length === 0 && !s.selectedProduct, JSON.stringify(s.cart));
  check('…and clears the saved address', !s.addressDetails && !s.customerProfile, JSON.stringify(s.customerProfile));
  check('…and says so honestly', /cleared/i.test(r.replyText) && /start fresh/i.test(r.replyText), r.replyText);

  id = await newCustomer(confirming);
  r = await ask(id, 'Helloo', V('greeting'));
  check('"Helloo" mid-order says hi and mentions the cart once', /Hi/.test(r.replyText) && /GUARDIOLA/.test(r.replyText), r.replyText);
  check('…without pushing "reply yes to confirm"', !/reply\s+"?yes/i.test(r.replyText), r.replyText);

  r = await ask(id, "I don't want that right now", V('pause_order'));
  s = await state(id);
  check('"not right now" keeps the cart and offers cancel', s.cart.length === 1 && /cancel/i.test(r.replyText), r.replyText);

  r = await ask(id, "Don't need to hold on just cancel it from my cart", V('cancel_cart'));
  s = await state(id);
  check('"cancel it from my cart" empties the cart in code', s.cart.length === 0 && !s.selectedProduct, JSON.stringify(s.cart));
  check('…with no support ticket', !/TKT-|ticket/i.test(r.replyText), r.replyText);
  check('…and no LLM call', llmCalls === 0, `llmCalls=${llmCalls}`);

  id = await newCustomer({ ...confirming, state: 'COLLECTING_ADDRESS', addressDetails: null, addressDraft: { name: 'PRANAV', pincode: '600023', phone: '9361475788' } });
  llmScript = [toolCall('search_products', { query: 'man city' })];
  r = await ask(id, 'I want Man City jersey', V('product_search', { search: 'man city' }));
  s = await state(id);
  check('"I want Man City jersey" is NEVER saved as the address', !/want/i.test(JSON.stringify(s.addressDraft || {})) && !/want/i.test(s.address || ''), JSON.stringify(s.addressDraft));
  check('…it searches Man City instead', /MAN(CHESTER)? CITY/i.test(r.replyText), r.replyText.slice(0, 200));
  // Since 2026-10-02 the cart holds several jerseys: the Guardiola shirt STAYS.
  check('…and the jersey already in the cart stays (several per order)', s.cart.length === 1 && s.cart[0].productId === GUARDIOLA.id && /apdiye iruku|stay/i.test(r.replyText), r.replyText.slice(0, 200));
  check('…no order summary with the old product', !/Reply "YES" to confirm/i.test(r.replyText), r.replyText.slice(0, 200));
}

// ---------------------------------------------------------------- 4. browsing
console.log('\n4. The 2026-09-29 chat — browsing countries');
{
  const id = await newCustomer();
  let r = await ask(id, 'Country category la enna enna options irukunu slunga', V('list_teams', { category: 'country' }));
  check('"country options" lists countries', /Portugal/.test(r.replyText) && /Germany/.test(r.replyText), r.replyText);
  check('…not clubs', !/Chelsea|Liverpool|Real Madrid/.test(r.replyText), r.replyText);

  r = await ask(id, 'Country jersey kaatunga', V('product_search', { category: 'country' }));
  const firstCount = (r.replyText.match(/^\d+\. /gm) || []).length;
  r = await ask(id, 'Ellam options uu list out pandrengala?', V('list_more'));
  const lines = (r.replyText.match(/^\d+\. /gm) || []).length;
  check('"list all options" shows MORE than the first three', lines > firstCount && lines > 3, `first=${firstCount} now=${lines}`);
  check('…from the same shelf (no IPL)', !/IPL|RCB|CSK/.test(r.replyText), r.replyText.slice(0, 300));
  const s = await state(id);
  check('…and they can pick any of them by number', (s.lastShownProducts || []).length === lines, `${(s.lastShownProducts || []).length} vs ${lines}`);

  const teams = woo.listTeams(20);
  check('the team list no longer offers "IPL" or "World Cup" as teams', !teams.some(t => /^(ipl|world cup)$/i.test(t)), teams.join(', '));
}

// ---------------------------------------------------------------- 4b. not understood
console.log('\n4b. "Enna bro pesuradhe purila" — they cannot understand us');
{
  const id = await newCustomer();
  const r = await ask(id, 'Enna bro pesuradhe purila', V('not_understood', { mood: 'confused' }));
  check('a fixed plain-English recovery with the real team list', /simple ah solren/.test(r.replyText) && /Real Madrid/.test(r.replyText), r.replyText);
  check('…not the complaint template', !/order ID/i.test(r.replyText), r.replyText);
  check('…and no LLM call', llmCalls === 0, `llmCalls=${llmCalls}`);
}

// ---------------------------------------------------------------- 5. agent guard
console.log('\n5. The agent searches when nobody asked for products');
{
  const id = await newCustomer({ lastShownProducts: [], productListPending: false });
  llmScript = [toolCall('search_products', { query: 'jersey' }), say('Shipping India full ah free dhaan.')];
  const r = await ask(id, 'shipping charge iruka?', V('product_question', { meaning: 'Asks whether there is a shipping charge.' }));
  check('a broad search is handed back instead of printing the team list', !TEAM_LIST.test(r.replyText), r.replyText);
  const toolMsg = (lastMessages || []).find(m => m.role === 'tool');
  check('…with "not a product request" and the meaning', /not_a_product_request/.test(toolMsg?.content || '') && /shipping charge/.test(toolMsg?.content || ''), toolMsg?.content);
  const note = (lastMessages || []).find(m => m.role === 'system' && /WHAT THE CUSTOMER MEANS/.test(m.content));
  check('the agent is given the meaning right before the message', Boolean(note), '');
}

// ---------------------------------------------------------------- 6. address still works
console.log('\n6. Real addresses and picks still flow in code');
{
  const id = await newCustomer({ cart: [item(GUARDIOLA)], selectedProduct: lockOf(GUARDIOLA), state: 'COLLECTING_ADDRESS' });
  const r = await ask(id, 'PRANAV, No.38 Mylappa Street, Ayanavaram, Chennai 600023, 9361475788', V('give_address'));
  const s = await state(id);
  check('an address is captured and the summary shown', s.state === 'CONFIRMING_ORDER' && s.addressDetails?.pincode === '600023' && /YES/.test(r.replyText), r.replyText);
  check('…with no LLM call', llmCalls === 0, `llmCalls=${llmCalls}`);

  const shown = products.filter(p => p.stock_status === 'instock' && woo.hasValidPrice(p)).slice(0, 3)
    .map(p => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [], permalink: '' }));
  const id2 = await newCustomer({ lastShownProducts: shown, productListPending: true });
  await ask(id2, '2', V('pick_product', { pick: 2 }));
  const size = String(shown[1].sizes?.[0] || 'M').split('-')[0];
  await ask(id2, `${size} 7`, V('size_qty', { size, qty: 7 }));
  const s2 = await state(id2);
  check('"2" then "<size> 7" carts product #2 at qty 7', s2.cart[0]?.productId === shown[1].productId && s2.cart[0]?.qty === 7, JSON.stringify(s2.cart));

  const orderState = (await import('./services/orderState.js')).default;
  check('the fallback address reader no longer takes "I want Man City jersey"', !orderState.parseAddressParts('I want Man City jersey').address, '');
  check('…but still reads "No 12 Gandhi street, Salem"', /Gandhi/.test(orderState.parseAddressParts('No 12 Gandhi street, Salem').address || ''), '');
}

// ---------------------------------------------------------------- 7. confirm + history
console.log('\n7. Confirming by meaning, and remembering the order afterwards');
{
  const id = await newCustomer({ cart: [item(GUARDIOLA)], selectedProduct: lockOf(GUARDIOLA), state: 'CONFIRMING_ORDER', addressDetails: ADDRESS });
  const realConfirm = aiService._confirmOrderNow;
  aiService._confirmOrderNow = async () => ({ ok: true, created: true, orderId: 88001, checkoutUrl: PAY_URL });
  const r = await ask(id, 'ok go ahead, place it', V('confirm_order'));
  aiService._confirmOrderNow = realConfirm;
  const s = await state(id);
  check('"ok go ahead, place it" confirms (not only a bare "yes")', /88001/.test(r.replyText) && s.lastOrder?.orderId === 88001, r.replyText);
  check('the confirmation stays in history for the next question', s.history.length === 2 && /88001/.test(s.history[1].content), JSON.stringify(s.history));

  const id2 = await newCustomer({ cart: [item(GUARDIOLA)], selectedProduct: lockOf(GUARDIOLA), state: 'CONFIRMING_ORDER', addressDetails: ADDRESS });
  aiService._confirmOrderNow = async () => { throw new Error('must not confirm'); };
  const r2 = await ask(id2, 'Okay', V('closing'));
  aiService._confirmOrderNow = realConfirm;
  check('an "okay" the model reads as closing does NOT place the order', !/confirm aayiduchu|must not/i.test(r2.replyText) && (await state(id2)).cart.length === 1, r2.replyText);
}

// ---------------------------------------------------------------- 8. fallback
console.log('\n8. When the model cannot be reached, the keyword chain still answers');
{
  const id = await newCustomer();
  const r = await ask(id, 'Enna kind of jersey iruku ungata?', null);
  check('no verdict → the old browse menu still works', /Club football jerseys/.test(r.replyText), r.replyText.slice(0, 120));
}

// ---------------------------------------------------------------- 8b. change only the address
console.log('\n8b. The 2026-10-01 chat — "keep the jersey, change only the address"');
{
  const OLD = { name: 'Sess', address: '90, Indian, salem-678678', pincode: '678678', phone: '7655788766' };
  const base = () => ({ cart: [item(GUARDIOLA, 'M', 5)], selectedProduct: lockOf(GUARDIOLA), state: 'CONFIRMING_ORDER',
    addressDetails: { ...OLD }, customerProfile: { ...OLD }, addressDraft: { ...OLD } });
  const orderState = (await import('./services/orderState.js')).default;
  check('"Address change panniten" is not read as an address', !orderState.parseAddressParts('Address change panniten').address, '');
  check('"intha address venaam vera address kudukuren" is not an address', !orderState.parseAddressParts('I mean intha address venaam vera address kudukuren').address, '');
  check('"Address: …" and "Address 12 Gandhi street" still are', /Gandhi/.test(orderState.parseAddressParts('Address 12 Gandhi street, Salem').address || '')
    && /Lake/.test(orderState.parseAddressParts('Address: 4 Lake view road, Madurai').address || ''), '');

  // The intended reading.
  const id = await newCustomer(base());
  const r1 = await ask(id, 'Address change panniten', V('change_address'));
  let s = await state(id);
  check('change_address keeps the jersey and drops the old address', s.cart.length === 1 && s.cart[0].qty === 5 && !s.addressDetails && !s.customerProfile && s.state === 'COLLECTING_ADDRESS', JSON.stringify({ cart: s.cart, a: s.addressDetails, st: s.state }));
  check('…and asks in the usual format', /Name, Address, Pincode, Mobile number/.test(r1.replyText) && !TEAM_LIST.test(r1.replyText) && llmCalls === 0, r1.replyText);
  const r2 = await ask(id, 'Ravi, No 5 Gandhi street, Salem 636001, 9876543210', V('give_address'));
  s = await state(id);
  check('the new address replaces the old one in the summary', s.addressDetails?.pincode === '636001' && /Gandhi/.test(r2.replyText) && !/678678/.test(r2.replyText) && s.cart[0]?.qty === 5, r2.replyText);

  // The misread that happened live: "Ithu venaam" read as cancel_cart right after talking about the address.
  const id2 = await newCustomer(base());
  await ask(id2, 'Address change panniten', V('change_address'));
  await dbService.saveSession(id2, Object.assign(await state(id2), base())); // as if the address step had not run
  const r3 = await ask(id2, 'Ithu venaam', V('cancel_cart'));
  s = await state(id2);
  check('"Ithu venaam" after talking about the address asks jersey-or-address instead of deleting', s.cart.length === 1 && /address/i.test(r3.replyText) && /jersey/i.test(r3.replyText), r3.replyText);
  const r4 = await ask(id2, 'jersey remove', V('cancel_cart'));
  s = await state(id2);
  check('…and a clear "jersey remove" then removes it, with an undo hint', s.cart.length === 0 && s.removedCart?.cart?.length === 1 && /undo/i.test(r4.replyText), r4.replyText);
  const r5 = await ask(id2, 'Last aa select panniruntha jersey ennaku okay thaa address matum change pannanum', V('restore_cart'));
  s = await state(id2);
  check('restore_cart puts the jersey back (same size and qty) and asks for the new address', s.cart[0]?.productId === GUARDIOLA.id && s.cart[0]?.qty === 5
    && /Name, Address, Pincode, Mobile number/.test(r5.replyText) && !TEAM_LIST.test(r5.replyText), r5.replyText);

  // change_address straight after a removal also restores.
  const id3 = await newCustomer({ ...base() });
  await ask(id3, 'remove the jersey', V('cancel_cart'));
  const r6 = await ask(id3, 'I mean intha address venaam vera address kudukuren', V('change_address', { mood: 'frustrated' }));
  s = await state(id3);
  check('change_address with an empty cart restores the removed jersey', s.cart.length === 1 && /thirumba cart la/.test(r6.replyText) && !TEAM_LIST.test(r6.replyText), r6.replyText);

  // Angry with nothing to act on → a person, once.
  const id4 = await newCustomer();
  const r7 = await ask(id4, 'Loosu theliva thana solren', V('other', { mood: 'angry', meaning: 'insulting the bot' }));
  const tickets = await dbService.getAllTickets();
  check('an angry message with nothing to act on hands off to a person with a ticket', /team kitta anuppitten/.test(r7.replyText) && llmCalls === 0
    && tickets.some(t => t.issueType === 'bot_handoff' && t.userId === id4), r7.replyText);
  const r8 = await ask(id4, 'Loosu', V('other', { mood: 'angry' }));
  check('…but not a second ticket within 2 hours', r8.intent !== 'understood_handoff', r8.intent);
  // Angry WITH an action → the action, prefixed with a sorry.
  const id5 = await newCustomer(base());
  const r9 = await ask(id5, 'Loosu theliva thana solren address change panna pothum nu', V('change_address', { mood: 'angry' }));
  check('an angry change_address does the change and says sorry first', /^Sorry, en thappu/.test(r9.replyText) && /Name, Address, Pincode, Mobile number/.test(r9.replyText), r9.replyText);

  // The understanding call failed (what really happened live) → keyword fallback.
  const id6 = await newCustomer(base());
  const r10 = await ask(id6, 'Address change panniten', null);
  s = await state(id6);
  check('no verdict: "Address change panniten" still keeps the jersey and asks for the new address', s.cart.length === 1 && !s.addressDetails && /Name, Address, Pincode, Mobile number/.test(r10.replyText), r10.replyText);
  const id7 = await newCustomer({ removedCart: { cart: [item(GUARDIOLA, 'M', 5)], selectedProduct: lockOf(GUARDIOLA), at: Date.now() }, addressDetails: { ...OLD } });
  const r11 = await ask(id7, 'Ithu remove pannathenga, address matum change panna podhum', null);
  s = await state(id7);
  check('no verdict: "remove pannathenga, address mattum" restores the jersey and asks for the address', s.cart.length === 1 && /Name, Address, Pincode, Mobile number/.test(r11.replyText) && !TEAM_LIST.test(r11.replyText), r11.replyText);
}

// ---------------------------------------------------------------- 8c. re-order after expiry
console.log('\n8c. "YES" after the expired-order note places the same order again');
{
  // Exactly the state followup.js leaves behind when an unpaid order was cancelled.
  const id = await newCustomer({ cart: [item(GUARDIOLA, 'M', 5)], selectedProduct: lockOf(GUARDIOLA), state: 'CONFIRMING_ORDER',
    addressDetails: ADDRESS, reorderOffered: true,
    lastOrder: { orderId: 77997, checkoutUrl: PAY_URL, at: Date.now() - 70 * 60 * 1000, expiredNoticeAt: Date.now() } });
  const realConfirm = aiService._confirmOrderNow;
  let placed = null;
  aiService._confirmOrderNow = async (s) => { placed = s.cart.map(i => `${i.productId}:${i.size}:${i.qty}`); return { ok: true, created: true, orderId: 88123, checkoutUrl: PAY_URL }; };
  const r = await ask(id, 'Yes', V('confirm_order'));
  aiService._confirmOrderNow = realConfirm;
  check('the restored cart is ordered again, same jersey/size/qty', placed?.[0] === `${GUARDIOLA.id}:M:5` && /88123/.test(r.replyText), JSON.stringify({ placed, reply: r.replyText }));
  check('the confirmation names the payment deadline', /kulla pay pannunga/.test(r.replyText), r.replyText);
}

// ---------------------------------------------------------------- 9. the module itself
console.log('\n9. services/understand.js');
{
  const { parseVerdict, buildMessages } = understandMod;
  const v = parseVerdict('```json\n{"intent":"delivery_question","topic":"delivery","mood":"fine","questions":["when will it arrive?"],"search":"","category":"none","pick":null,"size":"m","qty":"2","about_placed_order":true,"meaning":"asks delivery time","confidence":0.92}\n```');
  check('parses a fenced JSON verdict', v?.intent === 'delivery_question' && v.topic === 'delivery' && v.aboutPlacedOrder === true, JSON.stringify(v));
  check('normalises size and qty', v?.size === 'M' && v?.qty === 2, JSON.stringify(v));
  check('an unknown intent is rejected (→ keyword fallback)', parseVerdict('{"intent":"buy_everything"}') === null, '');
  check('prose is rejected', parseVerdict('The customer wants delivery info.') === null, '');
  check('junk values are cleaned', parseVerdict('{"intent":"other","mood":"sleepy","qty":-4,"pick":999,"size":"huge"}')?.mood === 'fine', '');
}

console.log('\n"Show other teams" after a one-shirt search (2026-10-02 chat)');
{
  const ARSENAL = products.find(p => /ARSENAL 2003-04 AWAY/.test(p.name));
  const shown = [lockOf(ARSENAL)];
  const id = await newCustomer({ lastShownProducts: shown, productListPending: true, lastListContext: { type: 'search', query: 'arsenal' } });
  const sent = [];
  let r = await ask(id, 'sari vera jersey\'s other teams ka kaatunga', V('list_more', { mood: 'fine' }));
  sent.push(r.replyText);
  check('"other teams" (read as list_more) does NOT resend the same Arsenal list', !/Stock la irukura ellaam 👇\n1\. \*?ARSENAL/.test(r.replyText), r.replyText.slice(0, 200));
  check('…says Arsenal has only this one, then shows the category menu', /Arsenal la ippo indha oru jersey/.test(r.replyText) && /Namma kitta idhellaam iruku/.test(r.replyText), r.replyText.slice(0, 300));
  check('…and costs no LLM call', llmCalls === 0, `llmCalls=${llmCalls}`);

  const id2 = await newCustomer({ lastShownProducts: shown, productListPending: true, lastListContext: { type: 'search', query: 'arsenal' } });
  r = await ask(id2, 'i asked u to show ur other best selling products', V('list_more', { mood: 'frustrated', meaning: 'wants other best selling products' }));
  const s2 = await state(id2);
  check('"other best selling products" shows shop-wide best sellers', /adhigam vikkura jerseys/.test(r.replyText) && (s2.lastShownProducts || []).length > 1, r.replyText.slice(0, 300));
  check('…without the Arsenal shirt they already saw', !(s2.lastShownProducts || []).some(p => p.productId === ARSENAL.id), JSON.stringify(s2.lastShownProducts.map(p => p.name)));

  const id3 = await newCustomer({ lastMood: 'frustrated', history: [{ role: 'user', content: 'show me other teams' }, { role: 'assistant', content: 'Stock la irukura ellaam 👇' }] });
  r = await ask(id3, 'hey', V('greeting', { mood: 'frustrated' }));
  check('"hey" from a customer frustrated twice running is not a fresh "Vanakkam! Naan Aura" intro', !/Naan Aura/.test(r.replyText), r.replyText);
  // The 10/2 chat opened in English: after 6h idle the language is re-detected, and
  // "Hi new order place pannanum" carried no word the detector knew.
  for (const t of ['Hi new order place pannanum', 'Hi pudhusa order pannanum', 'sari vera jersey\'s other teams ka kaatunga', 'fine vidu']) {
    check(`"${t}" is detected as Tanglish`, aiService.detectLanguage(t) === 'tanglish', aiService.detectLanguage(t));
  }
  // 10/2 Brazil order: pincode printed twice, a corrupted saved address reused.
  const orderState = (await import('./services/orderState.js')).default;
  const pa = orderState.parseAddressParts('sessy, 90/1,indian bank colony,678687,9940974356');
  check('a bare pincode part is not kept inside the address text', pa.address === '90/1, indian bank colony' && pa.pincode === '678687', JSON.stringify(pa));
  check('"change panniten, 678678" is not a usable saved address', !orderState.isPlausibleAddress('change panniten, 678678'), '');
  check('…while real addresses still are', orderState.isPlausibleAddress('90/1, indian bank colony') && orderState.isPlausibleAddress('No.38 Mylappa Street, Chennai 600023'), '');
  const bad = await newCustomer({ customerProfile: { name: 'Sess', address: 'change panniten, 678678', pincode: '678678', phone: '7655788766' } });
  const badS = await state(bad);
  check('a corrupted saved address is asked for again, not reused', !aiService._knownAddress(badS).address, JSON.stringify(aiService._knownAddress(badS)));
  for (const t of ['show me other teams', 'I want Man City jersey', 'What is the delivery time?']) {
    check(`"${t}" stays English`, aiService.detectLanguage(t) === 'english', aiService.detectLanguage(t));
  }
}

{
  const { buildMessages } = understandMod;
  const s = await dbService.getSession('918000009999@c.us');
  Object.assign(s, { cart: [item(GUARDIOLA)], selectedProduct: lockOf(GUARDIOLA), state: 'CONFIRMING_ORDER',
    lastOrder: { orderId: 5, checkoutUrl: PAY_URL, at: Date.now() }, history: [{ role: 'assistant', content: 'Reply YES to confirm' }] });
  const msgs = buildMessages(s, 'Okay', (await import('./services/orderState.js')).default);
  check('the model sees the cart, the confirm step, the placed order and the chat', /GUARDIOLA/.test(msgs[1].content) && /reply YES/i.test(msgs[1].content) && /ALREADY PLACED: #5/.test(msgs[1].content) && /Reply YES to confirm/.test(msgs[1].content), msgs[1].content);
  check('the instructions are one fixed string (cacheable)', msgs[0].content === understandMod.SYSTEM, '');

  // The real method, with the provider chain stubbed.
  const proto = Object.getPrototypeOf(aiService);
  let seenOpts = null;
  const saveCall = aiService.callLLMWithFallback;
  aiService.callLLMWithFallback = async (m, lang, key, opts) => { seenOpts = opts; return { choices: [{ message: { content: '{"intent":"closing","mood":"frustrated","meaning":"done"}' } }] }; };
  const got = await proto.understandMessage.call(aiService, 'x@c.us', s, 'Okay');
  check('understandMessage calls the chain with no tools and a small budget', seenOpts?.noTools === true && seenOpts?.maxTokens <= 1000, JSON.stringify(seenOpts));
  check('…and returns the verdict', got?.intent === 'closing' && got?.mood === 'frustrated', JSON.stringify(got));
  const budgets = [];
  aiService.callLLMWithFallback = async (m, lang, key, opts) => {
    budgets.push(opts.maxTokens);
    return budgets.length === 1
      ? { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
      : { choices: [{ message: { content: '{"intent":"change_address","mood":"fine"}' } }] };
  };
  const retried = await proto.understandMessage.call(aiService, 'x@c.us', s, 'Address change panniten');
  check('an EMPTY verdict is retried once with double the budget (live 2026-10-01)', retried?.intent === 'change_address' && budgets.length === 2 && budgets[1] === budgets[0] * 2, JSON.stringify(budgets));
  aiService.callLLMWithFallback = async () => { throw new Error('All LLM providers failed'); };
  check('a provider failure returns null (keyword fallback), never throws', (await proto.understandMessage.call(aiService, 'x@c.us', s, 'Okay')) === null, '');
  config.understand.enabled = false;
  check('UNDERSTAND_ENABLED=false skips the call entirely', (await proto.understandMessage.call(aiService, 'x@c.us', s, 'Okay')) === null, '');
  config.understand.enabled = true;
  aiService.callLLMWithFallback = saveCall;
}

console.log('\nThe 10/2 Sporting CP chat — "9 la enna iruku?", "ithula vera variety", the shipping name');
{
  const id = await newCustomer();
  const s0 = await state(id);
  aiService.bestSellersReply('club', s0, 10);
  await dbService.saveSession(id, s0);
  const shown = (await state(id)).lastShownProducts;
  const nine = shown[8];
  let r = await ask(id, '9 la enna la Iruku?', V('product_question', { pick: 9 }));
  let s = await state(id);
  check('"9 la enna la Iruku?" shows product 9: name, price, sizes, link', r.replyText.includes(nine.name) && r.replyText.includes(`₹${nine.price}`) && /Sizes:/.test(r.replyText), r.replyText);
  check('…and selects it for size/qty', s.selectedProduct?.productId === nine.productId, JSON.stringify(s.selectedProduct));
  check('…with no LLM call', llmCalls === 0, `llmCalls=${llmCalls}`);

  r = await ask(id, 'Ithula inno enna enna variety Iruku?', V('list_more'));
  s = await state(id);
  check('"Ithula inno enna variety?" shows jerseys LIKE the selected one, not the same club list', !r.replyText.includes('Club football jerseys') && s.lastShownProducts.every(p => p.productId !== nine.productId), r.replyText.slice(0, 300));
  if (/SPORTING/.test(nine.name)) check('…the other Sporting CP shirt first, then the same player', /SPORTING CP 2001-02 HOME FULL SLEEVE/.test(s.lastShownProducts[0]?.name || '') && /RONALDO/.test(r.replyText), r.replyText.slice(0, 300));

  const id2 = await newCustomer();
  const t0 = await state(id2);
  aiService.bestSellersReply('club', t0, 10);
  await dbService.saveSession(id2, t0);
  r = await ask(id2, '9 okay bro athula vera type iruntha kaatunga', V('browse_catalogue'));
  check('"9 okay, athula vera type kaatunga" is more like #9, not the category menu', !/Namma kitta idhellaam iruku/.test(r.replyText) && /vera options/.test(r.replyText), r.replyText.slice(0, 200));

  const id3 = await newCustomer();
  const t1 = await state(id3);
  aiService.bestSellersReply('club', t1, 10);
  await dbService.saveSession(id3, t1);
  r = await ask(id3, '9', V('pick_product', { pick: 9 }));
  r = await ask(id3, 'S 3', V('size_qty', { size: 'S', qty: 3 }));
  r = await ask(id3, 'no', V('closing'));   // "need another jersey?" → no (2026-10-07)
  check('after "S 3" the bot asks for the name too — never claims a name it was not given', !/Name save panniten|Name,? .*save panniten/.test(r.replyText) && /Name/.test(r.replyText), r.replyText);
  r = await ask(id3, '90/1,state colony,salem\n636006\n9876789655', V('give_address'));
  check('the WhatsApp display name never becomes the shipping name', !/Sessy/.test(r.replyText) && /Name/.test(r.replyText), r.replyText);
}

console.log('\nThe 10/2 Nikss chat — several jerseys, seasons, lists, Spurs, greeting, reviews');
{
  const orderState = (await import('./services/orderState.js')).default;
  const BAYERN = products.find(p => /BAYERN MUNICH 1995-97 HOME — KLINSMANN/.test(p.name));
  const RM_FS = products.find(p => /REAL MADRID 25-26 THIRD FULL SLEEVE JERSEY — MBAPPE/.test(p.name));

  const e = orderState.extractEntities('Real Madrid 25/26 jersey Venum XXL', { awaiting: 'product', shownCount: 3 });
  check('"Real Madrid 25/26 jersey Venum XXL" is size XXL and NO quantity (was 26)', e.size === 'XXL' && e.qty === null, JSON.stringify(e));
  check('"Arsenal 2003-04 L 2" still reads qty 2', orderState.extractEntities('Arsenal 2003-04 L 2', { awaiting: 'size_qty' }).qty === 2, '');

  // The 10/2 "Real Madrid 25/26" pick was right: the half-sleeve one is out of stock, so only
  // the full sleeve fits. Two IN-STOCK Sporting CP Ronaldo shirts test the real ambiguity.
  if (RM_FS) check('"Real Madrid 25/26" with only one in stock is not ambiguous', aiService._ambiguousMatches('Real Madrid 25/26 jersey Venum XXL', { productId: RM_FS.id, name: RM_FS.name }) === null, '');
  const SPORT = products.find(p => /SPORTING CP 2001-2002 HOME - RONALDO RN/.test(p.name));
  if (SPORT) {
    const amb = aiService._ambiguousMatches('Sporting CP Ronaldo jersey venum M', { productId: SPORT.id, name: SPORT.name });
    check('"Sporting CP Ronaldo" fits two in-stock jerseys → the bot asks which', Array.isArray(amb) && amb.length === 2, JSON.stringify(amb?.map(p => p.name)));
    const SPORT_FS = products.find(p => /SPORTING CP 2001-02 HOME FULL SLEEVE/.test(p.name));
    if (SPORT_FS) check('…but "Sporting CP Ronaldo full sleeve" is clear', aiService._ambiguousMatches('Sporting CP Ronaldo full sleeve M', { productId: SPORT_FS.id, name: SPORT_FS.name }) === null, '');
  }

  const spurs = woo.searchProductsDetailed('spurs');
  check('"spurs" miss suggests football, never IPL/cricket', spurs.suggestions.length > 0 && !spurs.suggestions.some(p => /IPL|CSK|RCB|CHENNAI SUPER|ROYAL CHALLENGERS/i.test(p.name)), spurs.suggestions.map(p => p.name).join(' | '));

  // Bayern in the cart, then "I also want a Real Madrid jersey".
  const id = await newCustomer({ cart: [{ ...item(BAYERN, 'XXL', 1) }], selectedProduct: lockOf(BAYERN), state: 'COLLECTING_ADDRESS' });
  llmScript = [toolCall('search_products', { query: 'real madrid' })];
  let r = await ask(id, 'I also want a Real Madrid jersey ??', V('product_search', { search: 'real madrid' }));
  let s = await state(id);
  check('"I also want a Real Madrid jersey" keeps Bayern in the cart', s.cart.length === 1 && s.cart[0].productId === BAYERN.id && !/remove panniten/.test(r.replyText), r.replyText.slice(0, 160));
  const shownNow = (r.replyText.match(/^\d+\. /gm) || []).length;
  check('the stored list is exactly what was shown (3, not 10)', s.lastShownProducts.length === shownNow && shownNow > 0, `${s.lastShownProducts.length} vs ${shownNow}`);
  r = await ask(id, 'XXL', V('size_qty', { size: 'XXL' }));
  check('"XXL" with no pick asks among the numbers SHOWN only', !new RegExp(`\\b${shownNow + 1}\\b`).test(r.replyText.split('?')[0]), r.replyText);
  const pickedRM = s.lastShownProducts[0];
  await ask(id, '1', V('pick_product', { pick: 1 }));
  r = await ask(id, '1', V('size_qty', { qty: 1 }));
  s = await state(id);
  check('picking a Real Madrid one ADDS it: 2 jerseys in the cart', s.cart.length === 2 && s.cart[0].productId === BAYERN.id && s.cart[1].productId === pickedRM.productId && s.cart[1].size === 'XXL', JSON.stringify(s.cart.map(i => [i.name, i.size, i.qty])));
  check('…and the reply lists both', /BAYERN/.test(r.replyText) && /REAL MADRID/.test(r.replyText), r.replyText);

  r = await ask(id, 'remove the Bayern one', V('cancel_cart', { search: 'bayern' }));
  s = await state(id);
  check('"remove the Bayern one" removes only Bayern', s.cart.length === 1 && s.cart[0].productId === pickedRM.productId, JSON.stringify(s.cart.map(i => i.name)));

  // The AI writes the list itself (two searches in one turn → no template): the bot must
  // remember ONLY the shirts the AI showed, never the 10 results behind them.
  const rm = woo.searchProductsDetailed('real madrid').products;
  const idN = await newCustomer();
  const two = { role: 'assistant', content: '', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'search_products', arguments: JSON.stringify({ query: 'real madrid' }) } },
    { id: 'c2', type: 'function', function: { name: 'search_products', arguments: JSON.stringify({ query: 'real madrid' }) } },
  ] };
  llmScript = [two, say(`Iruku 👇\n1. *${rm[3].name}* — ₹${rm[3].price}\n2. *${rm[5].name}* — ₹${rm[5].price}\nEdhu venum?`)];
  await ask(idN, 'Real Madrid jersey iruka?', V('product_search', { search: 'real madrid' }));
  let sN = await state(idN);
  check('an AI-written list of 2 is remembered as exactly those 2, in order', sN.lastShownProducts.length === 2 && sN.lastShownProducts[0].productId === rm[3].id && sN.lastShownProducts[1].productId === rm[5].id, JSON.stringify(sN.lastShownProducts.map(p => p.name)));
  r = await ask(idN, 'XXL', V('size_qty', { size: 'XXL' }));
  check('…so "XXL" is asked "1 illa 2?" — never "1 … 10"', /1 illa 2/.test(r.replyText) && !/\b10\b/.test(r.replyText), r.replyText);

  // Summary + WooCommerce get every line.
  const id2 = await newCustomer({ cart: [item(BAYERN, 'XXL', 1), item(GUARDIOLA, 'M', 2)], state: 'CONFIRMING_ORDER', addressDetails: ADDRESS, customerProfile: ADDRESS });
  const s2 = await state(id2);
  const sum = aiService._summaryReply(s2);
  check('the order summary lists every jersey and the right total', /BAYERN/.test(sum) && /GUARDIOLA/.test(sum) && sum.includes(`₹${parseFloat(BAYERN.price) + 2 * parseFloat(GUARDIOLA.price)}`), sum);

  const line = { name: BAYERN.name, size: 'XXL', qty: 1 };
  check('qty 1 that the customer never said is pointed out', /1 jersey nu vechirukken/.test(aiService._addedLine({ language: 'tanglish', cart: [line] }, line, 'Bayern Munich klinsmann jersey XXL')), '');
  check('…but not when they said it', !/vechirukken/.test(aiService._addedLine({ language: 'tanglish', cart: [line] }, line, 'XXL 1')), '');

  // First message of a brand-new conversation gets a hello, whatever answers it.
  const fresh = `9188${Date.now() % 100000000}@c.us`;
  r = await ask(fresh, 'Hii bro jersey kadikuma??', V('browse_catalogue'));
  check('"Hii bro jersey kadikuma??" opens with a greeting (was missing)', /^Vanakkam! 👋 Naan Aura/.test(r.replyText), r.replyText.slice(0, 80));
  r = await ask(fresh, 'Club jerseys kaatunga', V('browse_catalogue'));
  check('…only on the first reply', !/^Vanakkam/.test(r.replyText), r.replyText.slice(0, 60));

  // Reviews.
  const posted = [];
  const realPost = woo.postOrderReview;
  woo.postOrderReview = async (orderId, opts) => { posted.push({ orderId, ...opts }); return { success: true, pending: true }; };
  const id3 = await newCustomer({ lastOrder: { orderId: 78005, checkoutUrl: PAY_URL, at: Date.now() - 5 * 24 * 3600 * 1000 }, customerProfile: ADDRESS });
  r = await ask(id3, 'Jersey vandhuchu bro, semma quality! Fit perfect', V('positive_review', { mood: 'fine' }));
  check('praise gets a thank-you and asks permission + stars', /thanks/i.test(r.replyText) && /star/i.test(r.replyText) && /website/i.test(r.replyText), r.replyText);
  check('…nothing is posted before the customer agrees', posted.length === 0, '');
  r = await ask(id3, '5 ⭐', V('other'));
  check('"5 ⭐" posts THEIR words with THEIR rating on order #78005', posted.length === 1 && posted[0].orderId === 78005 && posted[0].rating === 5 && /semma quality/.test(posted[0].review) && posted[0].reviewer === 'PRANAV', JSON.stringify(posted));
  check('…and says it will appear after approval', /team check panni/.test(r.replyText), r.replyText);
  const id4 = await newCustomer({ lastOrder: { orderId: 78006, checkoutUrl: PAY_URL, at: Date.now() } });
  await ask(id4, 'Super jersey bro', V('positive_review'));
  r = await ask(id4, 'no', V('closing'));
  check('"no" posts nothing', posted.length === 1 && /no problem/i.test(r.replyText), r.replyText);
  const id5 = await newCustomer();
  r = await ask(id5, 'Your jerseys are super', V('positive_review'));
  check('praise without any order: thanks, but no website review offer', !/website/i.test(r.replyText) && /thanks/i.test(r.replyText), r.replyText);
  woo.postOrderReview = realPost;
}

// ---------------------------------------------------------------- several sizes, one jersey
console.log('\nSeveral sizes of one jersey (2026-10-06 screenshot)');
{
  const hasML = p => ['M', 'L'].every(sz => (p.sizes || []).some(x => String(x).toUpperCase().split(/[-\s]/)[0] === sz));
  const KROOS = products.find(p => /REAL MADRID 14-15 THIRD.*KROOS/i.test(p.name) && hasML(p))
    || products.find(p => p.stock_status === 'instock' && woo.hasValidPrice(p) && hasML(p));
  const id = await newCustomer({
    language: 'english', cart: [item(KROOS, 'M', 1)], selectedProduct: lockOf(KROOS),
    state: 'CONFIRMING_ORDER', addressDetails: ADDRESS, customerProfile: ADDRESS,
  });
  // The reader added the two "one"s up: size M, qty 2 — exactly what produced "Size M, Qty 2".
  const r = await ask(id, 'Actually I want m size one and L size one', V('size_qty', { size: 'M', qty: 2 }));
  const s = await state(id);
  const lines = s.cart.map(i => `${i.size}x${i.qty}`).sort().join(',');
  check('"m size one and L size one" → one M and one L, not M × 2', lines === 'Lx1,Mx1', JSON.stringify(s.cart));
  check('…the summary shows both and the right total', /Size M, Qty 1/.test(r.replyText) && /Size L, Qty 1/.test(r.replyText) && r.replyText.includes(`₹${2 * parseFloat(KROOS.price)}`), r.replyText);
  check('…still ready to confirm, no LLM call', s.state === 'CONFIRMING_ORDER' && llmCalls === 0, `${s.state} llm=${llmCalls}`);

  const id2 = await newCustomer({ language: 'english', selectedProduct: lockOf(KROOS), state: 'COLLECTING_SIZE' });
  await ask(id2, '2 M 1 L', V('size_qty', { size: 'M', qty: 3 }));
  const s2 = await state(id2);
  check('"2 M 1 L" while choosing → two lines, M × 2 and L × 1', s2.cart.map(i => `${i.size}x${i.qty}`).sort().join(',') === 'Lx1,Mx2', JSON.stringify(s2.cart));

  const orderState = (await import('./services/orderState.js')).default;
  for (const t of ['M size 2', 'I m fine', 'is size m available in l?', 'm or l which fits me?', 'No.38 Ishwaryam flats, Chennai 600023, 9361475788']) {
    check(`"${t}" is not a size split`, orderState.extractSizeSplit(t) === null, JSON.stringify(orderState.extractSizeSplit(t)));
  }
}

// ---------------------------------------------------------------- "need another jersey?"
console.log('\n"Need another jersey?" before checkout (2026-10-07)');
{
  const MORE = /add another jersey|vera jersey venuma/i;
  // Address on file: the question comes first, the summary only after "no".
  let id = await newCustomer({ language: 'english', selectedProduct: lockOf(GUARDIOLA), state: 'COLLECTING_SIZE', customerProfile: ADDRESS });
  let r = await ask(id, 'M 1', V('size_qty', { size: 'M', qty: 1 }));
  let s = await state(id);
  check('a jersey added → "would you like another jersey?"', MORE.test(r.replyText) && /NO/.test(r.replyText), r.replyText);
  check('…before the order summary', !/Reply "YES" to confirm/.test(r.replyText) && s.state === 'COLLECTING_ADDRESS' && s.cart.length === 1, `${s.state} ${r.replyText}`);
  // The reader misreading "No" as "cancel the cart" must not matter.
  r = await ask(id, 'No', V('cancel_cart'));
  s = await state(id);
  check('"No" → the order summary with the saved address, cart kept', /Reply "YES" to confirm/.test(r.replyText) && s.cart.length === 1 && s.state === 'CONFIRMING_ORDER', r.replyText);
  check('…with no LLM call', llmCalls === 0, `llmCalls=${llmCalls}`);
  r = await ask(id, 'yes', V('confirm_order'));
  check('…and the next "yes" confirms as before (not another upsell)', !MORE.test(r.replyText), r.replyText.slice(0, 120));

  // No address yet: "no thanks" asks for the shipping details.
  id = await newCustomer({ selectedProduct: lockOf(GUARDIOLA), state: 'COLLECTING_SIZE' });
  r = await ask(id, 'M size 2', V('size_qty', { size: 'M', qty: 2 }));
  check('Tanglish: "Innum vera jersey venuma?"', /vera jersey venuma/.test(r.replyText), r.replyText);
  r = await ask(id, 'illa bro podhum', V('closing'));
  s = await state(id);
  check('"illa bro podhum" → asks the shipping details, cart kept', /Name, Address, Pincode, Mobile number/.test(r.replyText) && s.cart.length === 1, r.replyText);

  // "yes" asks which team; the cart stays.
  id = await newCustomer({ language: 'english', selectedProduct: lockOf(GUARDIOLA), state: 'COLLECTING_SIZE' });
  await ask(id, 'L 1', V('size_qty', { size: 'L', qty: 1 }));
  r = await ask(id, 'Yes', V('confirm_order'));
  s = await state(id);
  check('"Yes" → "which team or player?", no order placed', /which team or player/i.test(r.replyText) && s.cart.length === 1 && !s.lastOrder, r.replyText);
  check('…the question is asked once, not on every message', !s.awaitingMoreJerseys, String(s.awaitingMoreJerseys));

  // A bulk-size cart is not upsold.
  id = await newCustomer({ language: 'english', selectedProduct: lockOf(GUARDIOLA), state: 'COLLECTING_SIZE' });
  r = await ask(id, 'M 15', V('size_qty', { size: 'M', qty: 15 }));
  check('a bulk quantity is not asked "another jersey?"', !MORE.test(r.replyText), r.replyText);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
try { fs.rmSync(process.env.AURAX_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed > 0 ? 1 : 0);

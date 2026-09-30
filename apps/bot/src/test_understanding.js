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
  check('…and says the old shirt left the cart', /GUARDIOLA/.test(r.replyText) && /out of your cart|remove/i.test(r.replyText), r.replyText.slice(0, 200));
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
  aiService.callLLMWithFallback = async () => { throw new Error('All LLM providers failed'); };
  check('a provider failure returns null (keyword fallback), never throws', (await proto.understandMessage.call(aiService, 'x@c.us', s, 'Okay')) === null, '');
  config.understand.enabled = false;
  check('UNDERSTAND_ENABLED=false skips the call entirely', (await proto.understandMessage.call(aiService, 'x@c.us', s, 'Okay')) === null, '');
  config.understand.enabled = true;
  aiService.callLLMWithFallback = saveCall;
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
try { fs.rmSync(process.env.AURAX_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed > 0 ? 1 : 0);

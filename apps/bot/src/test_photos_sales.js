/**
 * Photos, the post-order upsell and the discount rule — `npm run test-photos-sales`.
 *
 * From the owner's request of 2026-10-24:
 *   - five photos of one problem get ONE reply (and one ticket), two different jerseys get one
 *     message covering both, and "do you have this?" with reference photos gets one "we have
 *     it / we don't" plus jerseys worth showing;
 *   - after an order is placed the customer is asked whether they need another jersey;
 *   - a discount is mentioned only when the website shows one.
 * Plus the four bugs found the same day (an "another jersey" yes emptying the cart, a "no"
 * passing as a yes, "do you offer COD?" getting the offers list, start-over naming one jersey).
 *
 * Stubbed end to end: the vision model, the agent LLM, WhatsApp, WooCommerce orders and
 * tickets. Nothing is sent, nothing is ordered, no paid call is made. Temp AURAX_DATA_DIR.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-photos-'));
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-dummy-key';

const config = (await import('./config/config.js')).default;
const woo = (await import('./services/woocommerce.js')).default;
const dbService = (await import('./services/db.js')).default;
const whatsappWebBot = (await import('./services/whatsapp-web-bot.js')).default;
const knowledgeService = (await import('./services/knowledge.js')).default;
const retrievalService = (await import('./services/retrieval.js')).default;
const sheetsService = (await import('./services/sheets.js')).default;
const catchupService = (await import('./services/catchup.js')).default;
const visionService = (await import('./services/vision.js')).default;
const aiService = (await import('./services/ai.js')).default;

let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n──── ${t} ────`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- environment
whatsappWebBot.status = 'DISCONNECTED';
whatsappWebBot.client = null;
whatsappWebBot.sendText = async () => {};
sheetsService.appendRow = async () => {};
knowledgeService.match = async () => null;
retrievalService.buildContextMessage = async () => null;
catchupService.noteHandled = () => {};
catchupService.forgetChat = () => {};
config.owner.whatsappNumber = '';
config.vision = { enabled: true, model: 'test-vision', maxTokens: 100, maxImages: 6 };
aiService.fireworksClients = [{}];   // vision runs only with a Fireworks key; the call itself is stubbed

let nextVision = null;
let visionCalls = 0;
let visionImages = 0;
visionService.analyse = async (images) => { visionCalls++; visionImages = images.length; return nextVision; };
let nextVerdict = null;
aiService.understandMessage = async () => nextVerdict;
let llmScript = [];
aiService.callLLMWithFallback = async () => {
  const next = llmScript.shift();
  return { choices: [{ message: next || { role: 'assistant', content: 'Sure!' } }] };
};

const tickets = [];
dbService.saveTicket = async (t) => { const ticket = { ...t, id: `TKT-${tickets.length + 1}` }; tickets.push(ticket); return ticket; };
const alerts = [];
aiService.sendSupportTicketAlert = (id, ticket) => { alerts.push(ticket.id); };

const V = (intent, extra = {}) => ({
  intent, topic: 'none', mood: 'fine', questions: [], search: '', category: 'none',
  pick: null, size: null, qty: null, aboutPlacedOrder: false, meaning: '', confidence: 0.9, ...extra,
});
const G = (images, team, extra = {}) => ({
  images, what: 'jersey', team, season: '', kit: 'unknown', colours: '', player: '', sleeve: 'unknown',
  kids: false, issue: '', search: team ? team.toLowerCase() : '', confidence: team ? 'high' : 'low', ...extra,
});
const IMG = { mimetype: 'image/jpeg', data: 'AAAA' };
const imgs = (n) => Array.from({ length: n }, () => IMG);

let n = 0;
const newCustomer = async (overrides = {}) => {
  const id = `9181000000${String(++n).padStart(2, '0')}@c.us`;
  const s = await dbService.getSession(id);
  Object.assign(s, {
    language: 'english', firstContactLogged: true, history: [], cart: [], state: 'IDLE',
    lastShownProducts: [], productListPending: false, lastActive: new Date().toISOString(),
  }, overrides);
  await dbService.saveSession(id, s);
  llmScript = [];
  return id;
};
const sendPhotos = (id, count, caption = '') => aiService.answerQuery(id, caption, 'Sessy', null,
  { hasMedia: true, images: imgs(count), imageCount: count });
const ask = (id, text, verdict = null) => { nextVerdict = verdict; return aiService.answerQuery(id, text, 'Sessy', null); };

// Catalogue fixtures, chosen from the real cache so the test follows the shop.
const madrid = woo.searchProductsDetailed('real madrid');
const barca = woo.searchProductsDetailed('barcelona');
const miss = woo.searchProductsDetailed('napoli');
if (madrid.matchQuality !== 'exact' || barca.matchQuality !== 'exact' || miss.matchQuality === 'exact') {
  console.error('Fixture problem: expected Real Madrid + Barcelona in stock and no Napoli.', madrid.matchQuality, barca.matchQuality, miss.matchQuality);
  process.exit(1);
}

// ================================================================ vision verdict parsing
section('1. The vision answer is cleaned before anything trusts it');
{
  const v = visionService.parseVerdict('thinking... {"purpose":"support_issue","groups":[{"images":[1,2,9],"team":"Real Madrid","issue":"torn sleeve","confidence":"high","search":"real madrid home"},{"images":[2,3],"team":"","confidence":"low","search":"barca"}],"orderText":"#77997","summary":"torn"}', 3);
  check('the JSON is found after reasoning text', v && v.purpose === 'support_issue');
  check('a photo number that was never sent is dropped', v.groups[0].images.join() === '1,2');
  check('a photo is never in two groups', v.groups[1].images.join() === '3');
  check('no search is trusted when the team was not seen', v.groups[1].search === '');
  check('an unusable answer is null, never a guess', visionService.parseVerdict('sorry, cannot help', 2) === null);
  check('an unknown purpose becomes "other"', visionService.parseVerdict('{"purpose":"buy","groups":[]}', 1).purpose === 'other');
}

// ================================================================ album batching
section('2. Five photos sent together are ONE turn');
{
  config.whatsappWeb.albumQuietMs = 120;
  config.whatsappWeb.albumLeadMs = 200;
  config.whatsappWeb.albumMaxWaitMs = 1500;
  const real = whatsappWebBot.handleIncomingMessage;
  const handled = [];
  whatsappWebBot.handleIncomingMessage = async (msg, album = null) => { handled.push({ msg, album }); };
  const photo = (from, ts) => ({ from, hasMedia: true, type: 'image', body: '', timestamp: ts });
  const text = (from, body, ts) => ({ from, hasMedia: false, type: 'chat', body, timestamp: ts });

  for (let i = 0; i < 5; i++) whatsappWebBot.enqueueMessage(photo('a@c.us', i));
  await sleep(400);
  check('five photos → handled once', handled.length === 1, `handled ${handled.length}`);
  check('…with all five in the album', handled[0]?.album?.messages.length === 5);

  handled.length = 0;
  whatsappWebBot.enqueueMessage(text('b@c.us', 'do you have this?', 1));
  await sleep(50);
  whatsappWebBot.enqueueMessage(photo('b@c.us', 2));
  whatsappWebBot.enqueueMessage(photo('b@c.us', 3));
  await sleep(400);
  check('"do you have this?" then two photos → one turn of three messages',
    handled.length === 1 && handled[0].album?.messages.length === 3, `handled ${handled.length}`);

  handled.length = 0;
  whatsappWebBot.enqueueMessage(text('c@c.us', 'do you have this?', 1));
  await sleep(450);
  check('"do you have this?" with no photo after it is answered on its own',
    handled.length === 1 && handled[0].album === null);

  handled.length = 0;
  whatsappWebBot.enqueueMessage(text('d@c.us', 'Real Madrid jersey iruka', 1));
  await sleep(30);
  check('an ordinary message is not held back', handled.length === 1 && handled[0].album === null);

  handled.length = 0;
  whatsappWebBot.enqueueMessage(photo('e@c.us', 1));
  await sleep(400);
  whatsappWebBot.enqueueMessage(text('e@c.us', 'size M please', 2));
  await sleep(50);
  check('a message after the album closed is its own turn', handled.length === 2 && handled[1].album === null);
  whatsappWebBot.handleIncomingMessage = real;
}

section('3. The album reaches the agent as one call, and gets one reply');
{
  const calls = [];
  const realAnswer = aiService.answerQuery;
  aiService.answerQuery = async (id, body, name, phone, opts) => {
    calls.push({ body, opts });
    return { replyText: 'one reply', intent: 'photo_enquiry', requiresEscalation: false, suggestedProductIds: [], forwardPhotos: calls.length > 1 };
  };
  const sent = [];
  whatsappWebBot.sendText = async (to, content) => { sent.push({ to, content }); };
  whatsappWebBot.humanizeDelay = async () => {};
  config.wati.allowedTestNumbers = [];
  const mk = (body, ts, media = true) => ({
    from: '919000000001@c.us', hasMedia: media, type: media ? 'image' : 'chat', body, timestamp: ts,
    getContact: async () => ({ pushname: 'Ravi', number: '919000000001' }),
    getChat: async () => null,
    downloadMedia: async () => ({ mimetype: 'image/jpeg', data: 'AAAA', filename: null }),
  });
  const album = { messages: [mk('', 1), mk('', 2), mk('', 3), mk('', 4), mk('do you have this?', 5)] };
  await whatsappWebBot.handleIncomingMessage(album.messages[0], album);
  check('one answerQuery call for the whole album', calls.length === 1);
  check('…carrying all five photos', calls[0]?.opts.images.length === 5 && calls[0]?.opts.imageCount === 5);
  check('…and the caption', calls[0]?.body === 'do you have this?');
  check('one reply to the customer, and reference photos are not forwarded', sent.length === 1, `sent ${sent.length}`);

  sent.length = 0;
  config.owner.whatsappNumber = '910000000000';
  whatsappWebBot.status = 'CONNECTED';
  await whatsappWebBot.handleIncomingMessage(album.messages[0], album);
  const toOwner = sent.filter(s => s.to === '910000000000@c.us');
  check('a problem\'s photos go to the owner after the customer\'s reply',
    sent[0]?.to === '919000000001@c.us' && toOwner.length === 5, `owner got ${toOwner.length}`);
  whatsappWebBot.status = 'DISCONNECTED';
  config.owner.whatsappNumber = '';
  whatsappWebBot.sendText = async () => {};
  aiService.answerQuery = realAnswer;
}

// ================================================================ "do you have this?"
section('4. Reference photos: one answer — have it, or not, and something to show');
{
  let id = await newCustomer();
  nextVision = { purpose: 'product_enquiry', groups: [G([1, 2, 3, 4, 5], 'Real Madrid')], orderText: '', summary: 'Real Madrid jersey' };
  let r = await sendPhotos(id, 5, 'do you have this?');
  let s = await dbService.getSession(id);
  check('the vision model is asked once for all five photos', visionCalls === 1 && visionImages === 5);
  check('similar photos → one message saying we have it', /yes, we have it/i.test(r.replyText) && /Real Madrid/i.test(r.replyText), r.replyText);
  check('…with real products, numbered, ready to order', /\n1\. \*/.test(r.replyText) && s.lastShownProducts.length > 0);
  check('…no "(photos 1–5)" clutter when every photo is the same jersey', !/\(photos/.test(r.replyText));
  check('…and the owner is not sent reference photos', r.forwardPhotos === false);
  check('the history records what was sent', /\[sent 5 photos/.test(s.history.at(-2).content));

  id = await newCustomer();
  nextVision = { purpose: 'product_enquiry', groups: [G([1, 2], 'Real Madrid'), G([3], 'Barcelona')], orderText: '', summary: 'two jerseys' };
  r = await sendPhotos(id, 3, 'iruka?');
  check('two different jerseys → ONE message covering both',
    /Real Madrid/i.test(r.replyText) && /Barcelona/i.test(r.replyText) && /\(photos 1–2\)/.test(r.replyText) && /\(photo 3\)/.test(r.replyText), r.replyText);

  id = await newCustomer();
  nextVision = { purpose: 'product_enquiry', groups: [G([1, 2], 'Napoli')], orderText: '', summary: 'Napoli' };
  r = await sendPhotos(id, 2, '');
  s = await dbService.getSession(id);
  check('not in stock → says so plainly', /don't have this one/i.test(r.replyText), r.replyText);
  check('…then shows best sellers like a salesperson, numbered', /flying off the shelves/i.test(r.replyText) && s.lastShownProducts.length > 0);

  id = await newCustomer({ language: 'tanglish' });
  nextVision = { purpose: 'product_enquiry', groups: [G([1], 'Napoli'), G([2], 'Real Madrid')], orderText: '', summary: '' };
  r = await sendPhotos(id, 2, 'idhu iruka bro');
  check('one missing + one stocked → both answered, in Tanglish', /illa/.test(r.replyText) && /iruku!/.test(r.replyText), r.replyText);

  id = await newCustomer();
  nextVision = null;   // vision down
  r = await sendPhotos(id, 2, 'do you have this jersey?');
  check('vision down + "do you have this?" → one honest ask for the team, plus best sellers',
    /can't open photos/i.test(r.replyText) && /best sellers/i.test(r.replyText), r.replyText);
}

// ================================================================ support photos
section('5. Problem photos: one message, one ticket');
{
  let id = await newCustomer({ lastOrder: { orderId: 77997, at: Date.now() - 86400000, items: [] } });
  nextVision = {
    purpose: 'support_issue',
    groups: [G([1, 2, 3], 'Real Madrid', { issue: 'stitching coming off at the sleeve' }), G([4, 5], 'Barcelona', { issue: 'wrong size label (L instead of M)' })],
    orderText: '', summary: 'damaged Real Madrid, wrong size Barcelona',
  };
  const before = tickets.length;
  let r = await sendPhotos(id, 5, 'received damaged');
  check('five photos of two problems → one message naming both',
    /stitching coming off/.test(r.replyText) && /wrong size label/.test(r.replyText), r.replyText);
  check('…exactly one ticket, for the recent order', tickets.length === before + 1 && tickets.at(-1).orderId === '77997');
  check('…the ticket says what the photos show', /stitching coming off/.test(tickets.at(-1).description) && tickets.at(-1).hasPhoto === true);
  check('…the reply gives the ticket and asks if it is another order', r.replyText.includes(tickets.at(-1).id) && /different order/.test(r.replyText));
  check('…and the owner gets the photos', r.forwardPhotos === true);
  r = await sendPhotos(id, 2, 'one more photo');
  check('more photos of the same problem soon after → no second ticket', tickets.length === before + 1 && r.replyText.includes('TKT-'));

  id = await newCustomer();
  nextVision = { purpose: 'support_issue', groups: [G([1], 'Argentina', { issue: 'print peeling' })], orderText: '', summary: '' };
  const before2 = tickets.length;
  r = await sendPhotos(id, 1, '');
  check('no order known → asks for the order ID, no ticket yet', /order ID/i.test(r.replyText) && tickets.length === before2);
  llmScript = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_support_ticket', arguments: JSON.stringify({ customerName: 'Sessy', orderId: '77111', issueType: 'damaged', description: 'Print peeling' }) } }] },
    { role: 'assistant', content: 'Ticket raised.' }];
  await ask(id, 'order id 77111', null);
  check('the ticket raised next turn carries what the photo showed', /print peeling/.test(tickets.at(-1)?.description || ''), tickets.at(-1)?.description);

  id = await newCustomer();
  nextVision = { purpose: 'other', groups: [], orderText: '', summary: 'a selfie' };
  r = await sendPhotos(id, 1, '');
  check('an unclear photo with no words → one short question', r.intent === 'photo_unclear' && /looking for a jersey like this/.test(r.replyText));
}

// ================================================================ another jersey after the order
section('6. After the order: "need another jersey?"');
{
  const madridP = madrid.products[0];
  const confirmSession = () => ({
    state: 'CONFIRMING_ORDER',
    cart: [{ productId: madridP.id, name: madridP.name, price: madridP.price, size: 'M', qty: 1 }],
    addressDetails: { name: 'Sessy', phone: '9361475788', address: 'No.38 Mylappa Street, Chennai', pincode: '600023' },
    address: 'No.38 Mylappa Street, Chennai 600023',
  });
  woo.orderingAvailable = true;
  woo.createOrder = async () => ({ success: true, orderId: 78100, paymentUrl: 'https://theaurax.in/checkout/order-pay/78100/?pay_for_order=true&key=k' });

  let id = await newCustomer(confirmSession());
  let r = await ask(id, 'yes', null);
  check('the confirmation asks for another jersey', /order #78100 is placed/i.test(r.replyText) && /another jersey too/i.test(r.replyText), r.replyText);
  r = await ask(id, 'yes', null);
  let s = await dbService.getSession(id);
  check('"yes" → best sellers, numbered and ready to order', /best sellers/i.test(r.replyText) && s.lastShownProducts.length > 0, r.replyText);
  check('…not the jersey they just bought', !s.lastShownProducts.some(p => p.productId === madridP.id));

  id = await newCustomer(confirmSession());
  await ask(id, 'yes', null);
  r = await ask(id, 'no thanks', null);
  check('"no" → a warm close that points at the payment link', /complete the payment/i.test(r.replyText) && /Thanks for shopping/i.test(r.replyText), r.replyText);

  id = await newCustomer({ ...confirmSession(), language: 'tanglish' });
  r = await ask(id, 'seri', null);
  check('Tanglish confirmation asks in Tanglish', /Innum vera jersey venuma/.test(r.replyText), r.replyText);

  id = await newCustomer(confirmSession());
  r = await ask(id, 'yes, and I want another jersey too', V('confirm_order'));
  s = await dbService.getSession(id);
  check('"yes, and another jersey" (read as confirm) places the order — the cart is not emptied', /order #78100 is placed/i.test(r.replyText), r.replyText);
  check('…and asks which team, since they already said yes', /You mentioned another jersey/.test(r.replyText));

  id = await newCustomer(confirmSession());
  r = await ask(id, 'add another jersey', V('confirm_order'));
  s = await dbService.getSession(id);
  check('"add another jersey" without a yes keeps the cart and asks which team', s.cart.length === 1 && /Which team or player/.test(r.replyText), r.replyText);

  id = await newCustomer(confirmSession());
  r = await ask(id, "no don't place it", V('confirm_order'));
  s = await dbService.getSession(id);
  check('"no don\'t place it" misread as confirm → no order, summary again', s.cart.length === 1 && /Shall I place this order/.test(r.replyText), r.replyText);

  id = await newCustomer(confirmSession());
  r = await ask(id, 'Hi new order', V('confirm_order'));
  check('"Hi new order" still starts over, never confirms', r.intent === 'understood_start_over', r.intent);
}

// ================================================================ yes / no reading
section('7. Reading yes, fresh start and "another jersey"');
{
  for (const t of ["no don't place it", 'not okay', 'not fine', 'wait, correct the size first', 'k wait', 'hold on, book later', 'venaam'])
    check(`"${t}" is not a yes`, !aiService._saysYes(t));
  for (const t of ['yes', 'ok', 'confirm', 'seri', 'place it', 'go ahead 👍'])
    check(`"${t}" is a yes`, aiService._saysYes(t));
  check('"another jersey" is not a fresh start', !aiService._wantsFreshStart('yes, and I want another jersey too'));
  check('"innoru jersey venum" wants another', aiService._wantsAnotherJersey('innoru jersey venum, idhu ok'));
  check('"new order" is still a fresh start', aiService._wantsFreshStart('Hi new order'));
}

// ================================================================ discounts
section('8. Discounts only when the website shows one');
{
  for (const t of ['do you offer COD?', 'what sizes do you offer?', 'is this for sale or not'])
    check(`"${t}" is not a discount question`, !aiService._mentionsDiscount(t));
  for (const t of ['any discount?', 'Discount lam iruka bro', 'any offer?', 'offer iruka', 'coupon code?', 'is it on sale'])
    check(`"${t}" is a discount question`, aiService._mentionsDiscount(t));
  check('20 jerseys wholesale discount is not a retail discount question', !aiService._mentionsDiscount('wholesale discount for 20 jerseys'));

  const offers = woo.currentOffers(50);
  const unused = [5, 7, 13, 17, 23].find(p => !offers.some(o => o.percent === p));
  check('an invented % off is caught', aiService.inventedDiscounts(`Get ${unused}% off today!`, []).length === 1);
  if (offers.length) check('a real website offer passes', aiService.inventedDiscounts(`It's ${offers[0].percent}% off on the website`, []).length === 0);
  check('an invented coupon code is caught', aiService.inventedDiscounts('Use coupon code AURA10 at checkout', []).length === 1);
  check('a coupon the owner taught (in context) passes', aiService.inventedDiscounts('Use coupon code AURA10', [{ content: 'Coupon AURA10 gives 10% off' }]).length === 0);
  check('a promised price cut is caught', aiService.inventedDiscounts('Special price for you bro, ₹50 less', []).length === 1);
  check('a plain reply passes', aiService.inventedDiscounts('Shipping is free on every order 🚚', []).length === 0);

  const id = await newCustomer();
  llmScript = [
    { role: 'assistant', content: `Sure! Size M is available. I can give you a discount of ${unused}% today.` },
    { role: 'assistant', content: `Size M is available. And ${unused}% off just for you!` },
  ];
  const r = await ask(id, 'is size M available?', V('product_question'));
  check('an invented discount the model repeats is cut out of the reply', !new RegExp(`${unused}%`).test(r.replyText) && /Size M is available/.test(r.replyText), r.replyText);
}

// ================================================================ start over names every jersey
section('9. Starting over names every jersey removed');
{
  const [a, b] = madrid.products;
  const id = await newCustomer({
    state: 'COLLECTING_ADDRESS',
    cart: [{ productId: a.id, name: a.name, price: a.price, size: 'M', qty: 1 }, { productId: b.id, name: b.name, price: b.price, size: 'L', qty: 1 }],
  });
  const r = await ask(id, 'start over', V('start_over'));
  check('both jerseys are named', r.replyText.includes(a.name) && r.replyText.includes(b.name), r.replyText);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);

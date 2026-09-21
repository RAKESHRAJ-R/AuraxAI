/**
 * Order-confirmation regression suite — `npm run test-order-flow`.
 *
 * This exists because of the worst bug the project has shipped. Between 2026-08-07 and
 * 2026-09-21, when `createOrder()` failed, BOTH confirmation paths still told the customer
 * "Your order is confirmed!", then wiped the cart, the address and the history, and saved the
 * lead as 'completed' — with no order in WooCommerce, no owner alert, no ticket and no retry.
 * A proforma PDF was attached in place of a payment link, which made it look more official
 * still. For six weeks every single confirmed order went that way, because the REST API was
 * blocked the whole time and nothing checked.
 *
 * So the assertions here are mostly about what the bot must NOT say. It runs the real
 * `answerQuery` deterministic-confirm path (no LLM is involved in it) against a stubbed
 * WooCommerce, a stubbed database and a stubbed WhatsApp client: nothing is sent, no order is
 * placed, no network call is made.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-orderflow-'));

const config = (await import('./config/config.js')).default;
const woo = (await import('./services/woocommerce.js')).default;
const dbService = (await import('./services/db.js')).default;
const whatsappWebBot = (await import('./services/whatsapp-web-bot.js')).default;
const faqService = (await import('./services/faq.js')).default;
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

// ---------------------------------------------------------------- stubs
const SENDER = '919999999999@c.us';
let sessionStore = {};
let savedLeads = [];
let savedTickets = [];
let sentMessages = [];

const freshSession = () => ({
  state: 'CONFIRMING_ORDER',
  language: 'english',
  customerName: 'Test Customer',
  customerPhone: '9999999999',
  address: '12 Test Street, Chennai 600001',
  addressDetails: { name: 'Test Customer', phone: '9999999999', address: '12 Test Street', pincode: '600001' },
  cart: [{ productId: 101, name: 'AC MILAN 2006-07 AWAY — KAKA RN', price: '430', size: 'L', qty: 1 }],
  history: [],
  firstContactLogged: true,
  lastActive: new Date().toISOString(),
});

dbService.getSession = async () => sessionStore;
dbService.saveSession = async (id, s) => { sessionStore = s; };
dbService.saveLead = async (lead) => { savedLeads.push(lead); return lead; };
dbService.saveTicket = async (t) => {
  const ticket = { ...t, id: `TKT-${savedTickets.length + 1}` };
  savedTickets.push(ticket);
  return ticket;
};
// The knowledge/retrieval hooks must stay quiet — they are not what this suite tests.
dbService.getKnowledgeEntries = async () => [];
faqService.findAnswer = () => null;

// The owner alert is skipped when no owner number is configured, and a dev .env usually has
// none — pin it so the suite tests the alert instead of the absence of a setting.
config.owner.whatsappNumber = '910000000000';

whatsappWebBot.status = 'CONNECTED';
whatsappWebBot.client = {};
whatsappWebBot.sendText = async (to, body) => { sentMessages.push({ to, body }); };

const reset = () => {
  sessionStore = freshSession();
  savedLeads = [];
  savedTickets = [];
  sentMessages = [];
  woo.orderingAvailable = true;
  woo.orderingError = null;
};

const CONFIRM_WORDS = /(confirmed|order is confirmed|aayiduchi|order placed|has been placed)/i;

console.log('\n=== Order confirmation regression suite ===\n');

// ---------------------------------------------------------------- 1. the happy path
console.log('1. WooCommerce accepts the order');
{
  reset();
  woo.createOrder = async () => ({ success: true, orderId: 12345, paymentUrl: 'https://theaurax.in/checkout/order-pay/12345/?pay_for_order=true&key=wc_abc' });

  const res = await aiService.answerQuery(SENDER, 'yes');
  check('the deterministic path handled it (no LLM)', res.intent === 'deterministic_confirm', `intent=${res.intent}`);
  check('the real order ID is in the reply', res.replyText.includes('12345'), res.replyText);
  check('the payment link is pasted verbatim', res.replyText.includes('order-pay/12345'), res.replyText);
  check('the cart is cleared once the order is real', sessionStore.cart.length === 0);
  check('the session returns to IDLE', sessionStore.state === 'IDLE', sessionStore.state);
  check('the lead is marked completed', savedLeads.some(l => l.status === 'completed'));
  check('no COD is offered', !/\bCOD\b|cash on delivery/i.test(res.replyText), res.replyText);
  check('no owner alert on a clean success', sentMessages.length === 0, JSON.stringify(sentMessages));
}

// ---------------------------------------------------------------- 2. the regression
console.log('\n2. WooCommerce REFUSES the order (the 2026-08-07 bug)');
{
  reset();
  woo.createOrder = async () => ({ success: false, error: 'Request failed with status code 401', status: 401 });

  const res = await aiService.answerQuery(SENDER, 'yes');

  check('the reply does NOT claim the order is confirmed', !CONFIRM_WORDS.test(res.replyText), res.replyText);
  check('the reply says it did not go through', /(couldn't place|could not place|mudiyala|not been charged|NOT been charged)/i.test(res.replyText), res.replyText);
  check('no order ID is invented', !/#\d+/.test(res.replyText), res.replyText);
  check('no payment link is offered', !/order-pay|http/i.test(res.replyText), res.replyText);
  check('no proforma PDF is attached', !/invoice|\.pdf/i.test(res.replyText), res.replyText);

  check('the CART IS PRESERVED', sessionStore.cart.length === 1, JSON.stringify(sessionStore.cart));
  check('the address is preserved', Boolean(sessionStore.address));
  check('the session stays in CONFIRMING_ORDER so "yes" retries', sessionStore.state === 'CONFIRMING_ORDER', sessionStore.state);
  check('the lead is NOT marked completed', savedLeads.length > 0 && savedLeads.every(l => l.status !== 'completed'), JSON.stringify(savedLeads.map(l => l.status)));
  check('the lead is flagged for escalation', savedLeads.some(l => l.requiresEscalation === true));

  check('a support ticket is raised', savedTickets.length === 1, JSON.stringify(savedTickets));
  check('the ticket is typed order_failed', savedTickets[0]?.issueType === 'order_failed');
  check('the ticket carries the cart so it can be placed by hand', /AC MILAN/i.test(savedTickets[0]?.description || ''));
  check('the ticket reference is given to the customer', res.replyText.includes(savedTickets[0]?.id || 'nope'), res.replyText);

  check('the owner is alerted', sentMessages.length === 1, JSON.stringify(sentMessages));
  check('the alert names it as a failure', /ORDER FAILED/i.test(sentMessages[0]?.body || ''), sentMessages[0]?.body);
  check('the alert carries the error', /401/.test(sentMessages[0]?.body || ''));
  check('the turn is reported as an escalation', res.requiresEscalation === true && res.intent === 'order_failed', `${res.intent}/${res.requiresEscalation}`);
}

// ---------------------------------------------------------------- 3. a retry succeeds
console.log('\n3. The customer says "yes" again and it works');
{
  // Carries straight on from case 2: the cart survived, so one word is enough.
  woo.createOrder = async () => ({ success: true, orderId: 777, paymentUrl: 'https://theaurax.in/checkout/order-pay/777/?pay_for_order=true&key=wc_x' });
  sentMessages = [];

  const res = await aiService.answerQuery(SENDER, 'yes');
  check('the retry places the order', res.replyText.includes('777'), res.replyText);
  check('the preserved cart was used', res.intent === 'deterministic_confirm');
  check('the cart is cleared now', sessionStore.cart.length === 0);
}

// ---------------------------------------------------------------- 4. ordering known down
console.log('\n4. Ordering is already known to be down (boot health check)');
{
  reset();
  woo.orderingAvailable = false;
  woo.orderingError = 'HTTP 401 from wc/v3/orders';
  let createCalled = false;
  woo.createOrder = async () => { createCalled = true; return { success: true, orderId: 1, paymentUrl: 'x' }; };

  const res = await aiService.answerQuery(SENDER, 'yes');
  check('createOrder is not even attempted', createCalled === false);
  check('the customer is not told it worked', !CONFIRM_WORDS.test(res.replyText), res.replyText);
  check('the cart is preserved', sessionStore.cart.length === 1);
  check('the owner is alerted', sentMessages.length === 1);
}

// ---------------------------------------------------------------- 5. order but no link
console.log('\n5. Order created but WooCommerce returns no payment link');
{
  reset();
  woo.createOrder = async () => ({ success: true, orderId: 999, paymentUrl: null });

  const res = await aiService.answerQuery(SENDER, 'yes');
  check('the real order ID is still given', res.replyText.includes('999'), res.replyText);
  check('no payment link is fabricated', !/order-pay/.test(res.replyText), res.replyText);
  check('the customer is told a link is coming', /shortly|konja neram/i.test(res.replyText), res.replyText);
  check('a human is sent after it', sentMessages.length === 1 && /payment link/i.test(sentMessages[0].body));
  check('the cart is cleared (the order is real)', sessionStore.cart.length === 0);
}

// ---------------------------------------------------------------- 6. COD is gone
console.log('\n6. COD is not offered anywhere (Razorpay is the only gateway)');
{
  const faqs = faqService.getFAQs();
  const promises = faqs.filter(f =>
    /(we (support|offer|have)|yes,? we|available|iruku|rendumey)[^.]{0,60}(cash on delivery|\bCOD\b)/i.test(`${f.answer} ${f.answerTanglish || ''}`)
  );
  check('no FAQ answer promises COD', promises.length === 0, promises.map(f => f.category).join(', '));

  const codFee = faqs.filter(f => /₹\s*50[^.]{0,30}(COD|cash on delivery)|COD[^.]{0,30}₹\s*50/i.test(`${f.answer} ${f.answerTanglish || ''}`));
  check('the ₹50 COD fee claim is gone', codFee.length === 0, codFee.map(f => f.category).join(', '));

  const payment = faqs.find(f => f.keywords.includes('cod'));
  check('asking about COD gets an honest no', payment && /(prepaid only|isn't available|kidaiyaathu|don't offer)/i.test(payment.answer + payment.answerTanglish), payment?.answer);

  const src = fs.readFileSync(new URL('./services/ai.js', import.meta.url), 'utf8');
  check('no prompt or template offers "UPI or COD"', !/UPI (or|illa) COD/i.test(src));
  check('the prompt states prepaid-only explicitly', /PREPAID ONLY/i.test(src));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);

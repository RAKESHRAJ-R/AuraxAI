/**
 * Real-model check of the understanding step — `npm run replay-understanding -- --yes`.
 *
 * ⚠️ PAID: one small call to the live provider chain per message (~40 messages, Sarvam first
 * for Tanglish, roughly ₹0.01 each, about ₹1 in all). It refuses to run without --yes.
 *
 * test_understanding.js proves the bot ACTS correctly on a given meaning. This proves the
 * other half: that the real model READS each message from the 2026-09-29 chat and the
 * 2026-09-30 screenshots the way a person would. Every message is replayed with the order
 * state and chat it actually arrived in, and the verdict is compared with what it meant.
 *
 * Sends nothing, orders nothing, writes nothing (sessions are built in memory).
 */
if (!process.argv.includes('--yes')) {
  console.log('This calls the live LLM (~40 short calls, about ₹1). Re-run with --yes to proceed:');
  console.log('  npm run replay-understanding -- --yes');
  process.exit(0);
}

const aiService = (await import('./services/ai.js')).default;
const woo = (await import('./services/woocommerce.js')).default;

const products = woo.getLocalProducts();
const GUARDIOLA = products.find(p => /1899-1999 HOME — PEP GUARDIOLA/.test(p.name)) || products[0];
const SHEERAN = products.find(p => /ED SHEERAN 25-26 HOME/.test(p.name)) || products[1];
const KROOS = products.find(p => /GERMANY 2014 WORLD CUP AWAY - KROOS/.test(p.name)) || products[2];
const item = (p, size = 'M', qty = 1) => ({ productId: p.id, name: p.name, price: p.price, size, qty });
const lock = (p) => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [] });
const PAY = 'https://theaurax.in/checkout/order-pay/77997/?pay_for_order=true&key=wc_order_x';
const TEAMS = 'Idhellaam ippo stock la iruku 👇 • Real Madrid • FC Barcelona • AC Milan … Enna team venum?';
const ADDR = { name: 'PRANAV', address: 'No.38 Mylappa Street, Chennai', pincode: '600023', phone: '9361475788' };

const base = (o = {}) => ({ language: 'tanglish', history: [], cart: [], state: 'IDLE', lastShownProducts: [], ...o });
const h = (...pairs) => pairs.map(([role, content]) => ({ role, content }));
const afterOrder = (extra = []) => base({
  lastOrder: { orderId: 77997, checkoutUrl: PAY, at: Date.now() - 60000 },
  history: h(['user', 'Yes'], ['assistant', `Super! 🎉 Order #77997 confirm aayiduchu! ${PAY}`], ...extra),
});
const shown3 = [KROOS, GUARDIOLA, SHEERAN].map(p => ({ productId: p.id, name: p.name, price: p.price, sizes: p.sizes || [] }));
const confirming = (lang = 'english') => base({ language: lang, cart: [item(GUARDIOLA)], selectedProduct: lock(GUARDIOLA), state: 'CONFIRMING_ORDER', addressDetails: ADDR,
  history: h(['assistant', `Here's your order summary: • ${GUARDIOLA.name} — M size, 1 qty — ₹450 … Reply "YES" to confirm! 🎉`]) });

// [message, session, acceptable intents]
const CASES = [
  ['Hi', base({ language: 'english' }), ['greeting']],
  ['Enna kind of jersey iruku ungata?', base(), ['browse_catalogue', 'list_teams']],
  ['Country category la enna enna options irukunu slunga', base({ history: h(['assistant', '🌍 Country & World Cup jerseys — best sellers: 1. PORTUGAL … 2. PORTUGAL AWAY … 3. SPAIN …']) }), ['list_teams', 'list_more', 'product_search']],
  ['World cup jersey la enna enna option iruku?', base(), ['product_search', 'list_teams', 'list_more']],
  ['Ellam options uu list out pandrengala?', base({ lastShownProducts: shown3, productListPending: true, history: h(['user', 'World cup jersey'], ['assistant', `1. ${KROOS.name} 2. … 3. …`]) }), ['list_more']],
  ['2', base({ lastShownProducts: shown3, productListPending: true }), ['pick_product']],
  ['M 7', base({ selectedProduct: lock(KROOS), state: 'COLLECTING_SIZE', history: h(['assistant', `*${KROOS.name}* — enna size, evlo quantity venum?`]) }), ['size_qty']],
  ['Yes', base({ cart: [item(KROOS, 'M', 7)], selectedProduct: lock(KROOS), state: 'CONFIRMING_ORDER', addressDetails: ADDR, history: h(['assistant', 'Unga order summary … Confirm panna "YES" nu reply pannunga 🎉']) }), ['confirm_order']],
  ['Epo delivery aagum?', afterOrder(), ['delivery_question', 'order_status']],
  ['Delivery?', afterOrder([['user', 'Epo delivery aagum?'], ['assistant', TEAMS]]), ['delivery_question', 'order_status']],
  ['Already order placed payment matum pending', afterOrder([['user', 'Delivery?'], ['assistant', 'Standard delivery 5-7 working days. Udane order place pannuveengala?']]), ['order_status', 'payment_question']],
  ['Okay', afterOrder([['assistant', `Unga order #77997 ku payment link: ${PAY}`]]), ['closing']],
  ['Already order place panniten', afterOrder([['user', 'Okay'], ['assistant', TEAMS]]), ['order_status', 'closing']],
  ['So no need', afterOrder([['user', 'Already order place panniten'], ['assistant', TEAMS]]), ['closing']],
  ['No need', afterOrder([['assistant', 'Seri! Unga order status check pannanumna order ID anuppunga.'], ['assistant', TEAMS]]), ['closing']],
  ['Evolo naal agum bro', afterOrder(), ['delivery_question', 'order_status']],
  ['Delivery Evolo naal agum bro', afterOrder([['user', 'Evolo naal agum bro'], ['assistant', TEAMS]]), ['delivery_question', 'order_status']],
  ['Evolo naal agum bro jersey varadhuku', base({ cart: [item(SHEERAN)], selectedProduct: lock(SHEERAN), state: 'COLLECTING_ADDRESS', history: h(['assistant', 'Done! 🛒 cart la potten! Innum full address, Pincode, Mobile number anuppunga.']) }), ['delivery_question']],
  ['Delivery yepo bro', base({ cart: [item(SHEERAN)], selectedProduct: lock(SHEERAN), state: 'COLLECTING_ADDRESS' }), ['delivery_question']],
  ["Just forget me and my data let's start over", confirming(), ['start_over']],
  ['Helloo', confirming(), ['greeting']],
  ["I don't want that right now", confirming(), ['pause_order', 'cancel_cart']],
  ["Don't need to hold on just cancel it from my cart", confirming(), ['cancel_cart']],
  ['I want Man City jersey', base({ language: 'english', cart: [item(GUARDIOLA)], selectedProduct: lock(GUARDIOLA), state: 'COLLECTING_ADDRESS' }), ['product_search']],
  ['PRANAV, No.38 Mylappa Street, Ayanavaram, Chennai 600023, 9361475788', base({ cart: [item(GUARDIOLA)], selectedProduct: lock(GUARDIOLA), state: 'COLLECTING_ADDRESS' }), ['give_address']],
  ['Okay', confirming('tanglish'), ['confirm_order']],
  ['Enna bro pesuradhe purila', base({ history: h(['assistant', 'Oru team pechu sollu, best options kaanpidaven! 🔥']) }), ['not_understood', 'other', 'list_teams', 'browse_catalogue']],
  ['FC set la shorts varuma? size M irukka', base({ lastShownProducts: shown3, productListPending: true }), ['product_question', 'policy_question']],
  ['COD iruka?', base(), ['payment_question']],
  ['Name print panna evlo extra?', base(), ['policy_question', 'product_question']],
  ['Wrong size vandhuduchu, order 77990', base(), ['complaint']],
  ['Real Madrid 26/27 player version iruka', base(), ['product_search']],
  ['Thanks bro', afterOrder(), ['closing']],
  ['Human kitta pesanum', base(), ['human_request']],
];

let ok = 0;
for (const [msg, session, expect] of CASES) {
  const v = await aiService.understandMessage('replay@c.us', session, msg);
  const good = v && expect.includes(v.intent);
  if (good) ok++;
  console.log(`${good ? '✅' : '❌'} ${JSON.stringify(msg)}\n     → ${v ? `${v.intent}${v.topic !== 'none' ? '/' + v.topic : ''} mood=${v.mood} conf=${v.confidence}${v.search ? ` search="${v.search}"` : ''}${v.category !== 'none' ? ` cat=${v.category}` : ''}${v.pick ? ` pick=${v.pick}` : ''}${v.size ? ` size=${v.size}` : ''}${v.qty ? ` qty=${v.qty}` : ''} — ${v.meaning}` : 'NULL (keyword fallback)'}${good ? '' : `\n     expected: ${expect.join(' | ')}`}`);
}
console.log(`\n${ok}/${CASES.length} read as intended.`);
console.log(JSON.stringify(aiService.getProviderStats?.() || {}, null, 0).slice(0, 400));
process.exit(0);

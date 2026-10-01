/**
 * Follow-up regression suite — `npm run test-followup`.
 *
 * Cold-lead follow-up is the only feature that messages someone who did NOT just
 * message us, so the thing that matters is not that it works but that it STOPS:
 * never twice in a row, never more than the per-lead cap, never into a chat that
 * went quiet days ago, and never while the account's hourly chat budget is spent.
 *
 * Runs entirely against stubs — no WhatsApp session, no database, no network, and
 * nothing is ever sent.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

// Keep db.js off the live data dir even though every call is stubbed below.
process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-followup-'));

const config = (await import('./config/config.js')).default;
const dbService = (await import('./services/db.js')).default;
const whatsappWebBot = (await import('./services/whatsapp-web-bot.js')).default;
const followUpService = (await import('./services/followup.js')).default;
const woocommerceService = (await import('./services/woocommerce.js')).default;

// Pin the knobs the assertions below depend on. A developer's .env/.env.local may well
// have follow-ups switched off (it should, locally), and the suite tests the code, not
// whatever that machine happens to be configured for.
config.followUp.enabled = true;
config.followUp.inactiveHours = 3;
config.followUp.maxPerLead = 2;
config.followUp.maxPerRun = 8;
config.followUp.cooldownHours = 24;
config.followUp.maxLeadAgeDays = 3;
// Quiet hours off for the guard checks (the suite may run at night); tested on their own below.
config.followUp.quietStartHour = 0;
config.followUp.quietEndHour = 0;
config.followUp.paymentReminderMinutes = 25;
config.payment = { ...(config.payment || {}), holdMinutes: 60 };

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

/** Runs one check against a fixed set of leads and returns who would be messaged. */
async function run(leads, { budget = { hasRoom: true, used: 0, max: 30 } } = {}) {
  const sent = [];
  const bumped = [];
  dbService.getActiveLeads = async () => JSON.parse(JSON.stringify(leads));
  dbService.updateLeadFollowUp = async (userId) => { bumped.push(userId); };
  whatsappWebBot.client = {};
  whatsappWebBot.status = 'CONNECTED';
  whatsappWebBot.sendText = async (userId, message) => { sent.push({ userId, message }); };
  whatsappWebBot.chatBudget = () => budget;
  await followUpService.runFollowUpCheck();
  return { sent, bumped, ids: sent.map(s => s.userId) };
}

console.log('\n🧪 Follow-up guards\n');

// Baseline: the feature still does its job.
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Waiting', updatedAt: ago(4), followUpCount: 0 },
  ]);
  check('a lead quiet for 4h with no prior nudge is followed up', ids.length === 1, `sent ${ids.length}`);
}
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Fresh', updatedAt: ago(1), followUpCount: 0 },
  ]);
  check('a lead quiet for only 1h is left alone', ids.length === 0, `sent ${ids.length}`);
}

// The loop this suite exists for. Eligibility is measured from the CUSTOMER's last
// message, which our own follow-up does not move — so without a cooldown the second
// nudge goes out on the very next 30-minute run.
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Nudged', updatedAt: ago(4), followUpCount: 1, lastFollowUp: ago(0.5) },
  ]);
  check('no second nudge 30 minutes after the first', ids.length === 0, `sent ${ids.length}`);
}
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Nudged', updatedAt: ago(4), followUpCount: 1, lastFollowUp: ago(config.followUp.cooldownHours - 1) },
  ]);
  check('still silent just inside the cooldown window', ids.length === 0, `sent ${ids.length}`);
}
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Nudged', updatedAt: ago(4), followUpCount: 1, lastFollowUp: ago(config.followUp.cooldownHours + 1) },
  ]);
  check('the second nudge is allowed once the cooldown has passed', ids.length === 1, `sent ${ids.length}`);
}
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Done', updatedAt: ago(70), followUpCount: config.followUp.maxPerLead, lastFollowUp: ago(30) },
  ]);
  check('the per-lead cap holds while the customer has not replied — no third nudge', ids.length === 0, `sent ${ids.length}`);
}

// Age guard: an old lead is a cold contact, and messaging it is "starting a new chat".
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Ancient', updatedAt: ago(24 * 30), followUpCount: 0 },
  ]);
  check('a month-old lead is never re-engaged', ids.length === 0, `sent ${ids.length}`);
}
{
  const { ids } = await run([
    { userId: '911111111111@c.us', name: 'Yesterday', updatedAt: ago(20), followUpCount: 0 },
  ]);
  check('a lead from yesterday is still in range', ids.length === 1, `sent ${ids.length}`);
}
{
  const stale = Array.from({ length: 50 }, (_, i) => ({
    userId: `9122222222${String(i).padStart(2, '0')}@c.us`, name: `Old ${i}`, updatedAt: ago(24 * 14), followUpCount: 0,
  }));
  const { ids } = await run(stale);
  check('a freshly connected bot does not blast the old lead list', ids.length === 0, `sent ${ids.length}`);
}

// Volume guards.
{
  const many = Array.from({ length: 40 }, (_, i) => ({
    userId: `9133333333${String(i).padStart(2, '0')}@c.us`, name: `Lead ${i}`, updatedAt: ago(5), followUpCount: 0,
  }));
  const { ids } = await run(many);
  check(`one run stops at the per-run cap (${config.followUp.maxPerRun})`,
    ids.length === config.followUp.maxPerRun, `sent ${ids.length}`);
}
{
  const many = Array.from({ length: 10 }, (_, i) => ({
    userId: `9144444444${String(i).padStart(2, '0')}@c.us`, name: `Lead ${i}`, updatedAt: ago(5), followUpCount: 0,
  }));
  const { ids } = await run(many, { budget: { hasRoom: false, used: 30, max: 30 } });
  check('nothing goes out when the hourly chat budget is spent', ids.length === 0, `sent ${ids.length}`);
}

// Plumbing.
{
  const { ids } = await run([
    { userId: '911111111111@c.us', updatedAt: ago(4), followUpCount: 0 },
    { userId: '919876543210@g.us', updatedAt: ago(4), followUpCount: 0 },
    { userId: 'broken', updatedAt: ago(4), followUpCount: 0 },
    { userId: '912222222222@c.us', updatedAt: 'not-a-date', followUpCount: 0 },
  ]);
  check('groups, malformed ids and unparseable dates are skipped',
    ids.length === 1 && ids[0] === '911111111111@c.us', `sent ${JSON.stringify(ids)}`);
}
{
  const { sent, bumped } = await run([
    { userId: '911111111111@c.us', name: 'Carty', updatedAt: ago(4), followUpCount: 0, cart: [{ name: 'Barcelona Home 24/25' }] },
  ]);
  check('a cart lead is reminded about the actual product',
    sent.length === 1 && sent[0].message.includes('Barcelona Home 24/25'));
  check('the counter is bumped so the cap and cooldown can work at all',
    bumped.length === 1 && bumped[0] === '911111111111@c.us');
}
{
  whatsappWebBot.status = 'DISCONNECTED';
  const sent = [];
  dbService.getActiveLeads = async () => [{ userId: '911111111111@c.us', updatedAt: ago(4), followUpCount: 0 }];
  whatsappWebBot.sendText = async (id, m) => { sent.push(id); };
  await followUpService.runFollowUpCheck();
  check('a disconnected bot sends nothing', sent.length === 0, `sent ${sent.length}`);
  whatsappWebBot.status = 'CONNECTED';
}
{
  const original = config.followUp.enabled;
  config.followUp.enabled = false;
  const { ids } = await run([{ userId: '911111111111@c.us', updatedAt: ago(4), followUpCount: 0 }]);
  check('the kill switch stops the whole feature', ids.length === 0, `sent ${ids.length}`);
  config.followUp.enabled = original;
}

// ── 2026-10-01: nobody on the live number was ever reminded ──────────────────────────────
console.log('\n🧪 Who gets a cold nudge (2026-10-01)\n');
// A two-hour window around the service's OWN clock (the payment checks shift it forward),
// so the test cannot straddle an hour boundary.
const istHourAt = (t) => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date(t)));
const quietNow = () => { const h = istHourAt(followUpService.now()); config.followUp.quietStartHour = h; config.followUp.quietEndHour = (h + 2) % 24; };
const quietOff = () => { config.followUp.quietStartHour = 0; config.followUp.quietEndHour = 0; };
{
  const { ids } = await run([{ userId: '115566778899@lid', name: 'Lid', updatedAt: ago(4), followUpCount: 0 }]);
  check('a LID-based customer (…@lid) is followed up — it used to be skipped silently', ids.length === 1, `sent ${ids.length}`);
}
{
  quietNow();
  const { ids } = await run([{ userId: '911111111111@c.us', updatedAt: ago(4), followUpCount: 0 }]);
  quietOff();
  check('no cold nudge during quiet hours (it waits for the morning run)', ids.length === 0, `sent ${ids.length}`);
}
{
  const restarts = [];
  dbService.getActiveLeads = async () => [{ userId: '917777777777@c.us', name: 'Back', updatedAt: ago(4), followUpCount: 2, lastFollowUp: ago(30) }];
  dbService.updateLeadFollowUp = async (userId, opts) => { restarts.push(opts?.restart); };
  const sent = [];
  whatsappWebBot.sendText = async (userId, message) => { sent.push(message); };
  await followUpService.runFollowUpCheck();
  check('a customer who wrote back after two nudges can be nudged again (count restarts)', sent.length === 1 && restarts[0] === true, JSON.stringify({ sent: sent.length, restarts }));
  check('…and gets the FIRST-nudge wording, not "last reminder"', sent.length === 1 && !/last reminder/i.test(sent[0]), sent[0]);
}
{
  const mk = async (id, extra) => { const s = await dbService.getSession(id); Object.assign(s, extra); await dbService.saveSession(id, s); };
  await mk('918888800001@c.us', { lastOrder: { orderId: 1, checkoutUrl: 'u', at: Date.now() - 4 * HOUR } });
  await mk('918888800002@c.us', { closedAt: Date.now() - 4 * HOUR });
  await mk('918888800003@c.us', { handoffAt: Date.now() - 4 * HOUR });
  const { ids } = await run([
    { userId: '918888800001@c.us', updatedAt: ago(4), followUpCount: 0 },
    { userId: '918888800002@c.us', updatedAt: ago(4), followUpCount: 0 },
    { userId: '918888800003@c.us', updatedAt: ago(4), followUpCount: 0 },
  ]);
  check('no "still looking for jerseys?" after an order, a "no need", or a hand-off to the team', ids.length === 0, JSON.stringify(ids));
}

// ── Unpaid-order reminder ────────────────────────────────────────────────────────────────
console.log('\n🧪 Unpaid-order reminder (order #77997, 2026-09-29)\n');
{
  const MIN = 60 * 1000;
  const realNow = followUpService.now;
  // Sessions are stamped "last active" when saved; move the clock so the customer is idle.
  let shift = 10 * MIN;
  followUpService.now = () => Date.now() + shift;
  const at = (minsAgo) => followUpService.now() - minsAgo * MIN;
  const orders = {};
  woocommerceService.getOrder = async (id) => orders[id] ? { success: true, order: { id, status: orders[id] } } : { success: false, error: 'down' };
  let pid = 0;
  const PROFILE = { name: 'Sess', address: '90 Gandhi Street, Salem', pincode: '636001', phone: '7655788766' };
  const orderSession = async (minsAgo, status) => {
    const id = `9155500000${String(++pid).padStart(2, '0')}@lid`;
    const orderId = 90000 + pid;
    orders[orderId] = status;
    const s = await dbService.getSession(id);
    Object.assign(s, {
      language: 'tanglish', customerName: 'Sessy', history: [], cart: [], state: 'IDLE', customerProfile: { ...PROFILE },
      lastOrder: { orderId, checkoutUrl: `https://theaurax.in/pay/${orderId}`, at: at(minsAgo),
        items: [{ productId: 1, name: 'PORTUGAL AWAY WC RN', price: '430', size: 'M', qty: 5 }] },
    });
    await dbService.saveSession(id, s);
    return { id, orderId };
  };
  let sent = [];
  whatsappWebBot.client = {};
  whatsappWebBot.status = 'CONNECTED';
  whatsappWebBot.sendText = async (userId, message) => { sent.push({ userId, message }); };
  const pay = async () => { sent = []; await followUpService.runPaymentReminders(); return sent; };
  const to = (id) => sent.filter(m => m.userId === id);

  const a = await orderSession(30, 'pending');
  await pay();
  check('an unpaid order 30 min old gets ONE reminder with its payment link', to(a.id).length === 1 && to(a.id)[0].message.includes(`/pay/${a.orderId}`), JSON.stringify(to(a.id)));
  check('…saying how long is left before it auto-cancels', /30 nimishathukkulla pay pannalana/.test(to(a.id)[0]?.message || ''), to(a.id)[0]?.message);
  check('…recorded in the chat so the next turn knows', (await dbService.getSession(a.id)).history.some(h => /payment innum pending/.test(h.content)), '');
  await pay();
  check('…and never a second one', to(a.id).length === 0, `sent ${to(a.id).length}`);

  const b = await orderSession(10, 'pending');
  await pay();
  check('an order placed 10 min ago is left alone (too early)', to(b.id).length === 0, '');

  const c = await orderSession(30, 'processing');
  await pay();
  check('a PAID order gets a thank-you, not a reminder', to(c.id).length === 1 && /Payment vandhuduchu/.test(to(c.id)[0].message)
    && /romba thanks/.test(to(c.id)[0].message) && !/pending/.test(to(c.id)[0].message), JSON.stringify(to(c.id)));
  await pay();
  check('…only one thank-you', to(c.id).length === 0, '');

  const c2 = await orderSession(5, 'processing');
  await pay();
  check('a customer who pays within minutes is thanked then, not after 25 min', to(c2.id).length === 1 && /thanks/.test(to(c2.id)[0].message), '');

  const d = await orderSession(70, 'cancelled');
  await pay();
  const ds = await dbService.getSession(d.id);
  check('an order WooCommerce cancelled unpaid gets one note offering to place it again', to(d.id).length === 1 && /YES/.test(to(d.id)[0].message) && /auto-cancel/.test(to(d.id)[0].message), JSON.stringify(to(d.id)));
  check('…naming the jersey, never the vague "innum venumna"', /Indha jersey ippavum vaanganum na/.test(to(d.id)[0]?.message || '') && !/innum venumna/i.test(to(d.id)[0]?.message || ''), to(d.id)[0]?.message);
  check('…with the same jersey and address back at the confirm step, so "YES" re-orders', ds.cart?.[0]?.qty === 5 && ds.state === 'CONFIRMING_ORDER' && ds.addressDetails?.pincode === '636001', JSON.stringify({ cart: ds.cart, st: ds.state }));
  await pay();
  check('…only once', to(d.id).length === 0, '');

  quietNow();
  const e = await orderSession(30, 'pending');
  const f = await orderSession(70, 'cancelled');
  await pay();
  quietOff();
  check('the payment reminder still goes out at night (the link dies in an hour)', to(e.id).length === 1, '');
  check('…but the expired-order note waits for the morning', to(f.id).length === 0, '');
  await pay();
  check('…and goes out once quiet hours end', to(f.id).length === 1, '');

  const g = await orderSession(30, 'pending');
  delete orders[g.orderId]; // WooCommerce unreachable
  await pay();
  check('status unknown (WooCommerce down) → nothing sent, try again later', to(g.id).length === 0, '');

  shift = 0; // the customer is chatting right now
  const h = await orderSession(30, 'pending');
  await pay();
  check('a customer who is mid-conversation is not interrupted', to(h.id).length === 0, '');
  shift = 10 * MIN;

  whatsappWebBot.status = 'DISCONNECTED';
  const i = await orderSession(30, 'pending');
  await pay();
  whatsappWebBot.status = 'CONNECTED';
  check('a disconnected bot sends no payment reminder', to(i.id).length === 0, '');

  followUpService.now = realNow;
}

console.log(`\n${fail === 0 ? '✅ ALL CHECKS PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
try { fs.rmSync(process.env.AURAX_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);

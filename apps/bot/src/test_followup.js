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

// Pin the knobs the assertions below depend on. A developer's .env/.env.local may well
// have follow-ups switched off (it should, locally), and the suite tests the code, not
// whatever that machine happens to be configured for.
config.followUp.enabled = true;
config.followUp.inactiveHours = 3;
config.followUp.maxPerLead = 2;
config.followUp.maxPerRun = 8;
config.followUp.cooldownHours = 24;
config.followUp.maxLeadAgeDays = 3;

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
    { userId: '911111111111@c.us', name: 'Done', updatedAt: ago(4), followUpCount: config.followUp.maxPerLead, lastFollowUp: ago(72) },
  ]);
  check('the per-lead cap is final — no third nudge, ever', ids.length === 0, `sent ${ids.length}`);
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

console.log(`\n${fail === 0 ? '✅ ALL CHECKS PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
try { fs.rmSync(process.env.AURAX_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);

/**
 * WhatsApp self-healing regression suite — `npm run test-watchdog`.
 *
 * The bot has to answer customers 24/7 with nobody watching the server. What breaks in
 * practice is the headless Chrome, not the linked phone: it hangs, crashes, spins a core, or
 * leaks and then locks every later launch out of the session folder (2026-09-28). This drives
 * the watchdog against stubbed clients — no browser, no WhatsApp session, nothing sent.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-watchdog-'));

const config = (await import('./config/config.js')).default;
const bot = (await import('./services/whatsapp-web-bot.js')).default;

config.whatsappWeb.enabled = true;
config.whatsappWeb.watchdogMaxFailures = 3;
config.whatsappWeb.launchTimeoutMs = 240000;
config.whatsappWeb.cpuLimitPercent = 0; // /proc is Linux-only; CPU sampling is not what this suite tests

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`); }
}

// Never launch a real browser: record re-inits instead.
let reinits = [];
bot.scheduleReinit = (ms) => { reinits.push(ms); };

function stubClient({ state = 'CONNECTED', hangState = false, hangDestroy = false } = {}) {
  return {
    destroyed: false,
    getState: () => (hangState ? new Promise(() => {}) : Promise.resolve(state)),
    destroy() { this.destroyed = true; return hangDestroy ? new Promise(() => {}) : Promise.resolve(); },
    pupBrowser: null,
  };
}

function reset(client, status) {
  bot.client = client;
  bot.status = status;
  bot.watchdogFailures = 0;
  bot.recovering = false;
  bot.loggingOut = false;
  bot.connectingSince = Date.now();
  reinits = [];
}

console.log('\n1. A healthy connection is left alone');
{
  const c = stubClient();
  reset(c, 'CONNECTED');
  for (let i = 0; i < 5; i++) await bot.watchdogTick();
  check('client kept', bot.client === c && !c.destroyed);
  check('no restart scheduled', reinits.length === 0);
}

console.log('\n2. A disconnected state restarts only after N checks in a row');
{
  const c = stubClient({ state: 'TIMEOUT' });
  reset(c, 'CONNECTED');
  await bot.watchdogTick();
  await bot.watchdogTick();
  check('two bad checks: still tolerated', bot.client === c && reinits.length === 0);
  await bot.watchdogTick();
  check('third bad check: client torn down', bot.client === null && c.destroyed);
  check('re-init scheduled once', reinits.length === 1);
}

console.log('\n3. One good check in between resets the count');
{
  const c = stubClient({ state: 'TIMEOUT' });
  reset(c, 'CONNECTED');
  await bot.watchdogTick();
  await bot.watchdogTick();
  c.getState = () => Promise.resolve('CONNECTED');
  await bot.watchdogTick();
  c.getState = () => Promise.resolve('TIMEOUT');
  await bot.watchdogTick();
  await bot.watchdogTick();
  check('blip does not trigger a restart', bot.client === c && reinits.length === 0);
}

console.log('\n4. A page that never answers counts as a failure (20s timeout)');
{
  const c = stubClient({ hangState: true });
  reset(c, 'CONNECTED');
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a);
  try {
    for (let i = 0; i < 3; i++) await bot.watchdogTick();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  check('hung page restarted', bot.client === null && reinits.length === 1);
}

console.log('\n5. A launch stuck in CONNECTING is restarted');
{
  const c = stubClient();
  reset(c, 'CONNECTING');
  await bot.watchdogTick();
  check('fresh launch left alone', bot.client === c);
  bot.connectingSince = Date.now() - 5 * 60000;
  await bot.watchdogTick();
  check('stale launch torn down and retried', bot.client === null && reinits.length === 1);
}

console.log('\n6. Waiting for a human to scan is not "stuck"');
{
  for (const status of ['QR_READY', 'CODE_READY']) {
    const c = stubClient({ state: 'UNPAIRED' });
    reset(c, status);
    bot.connectingSince = Date.now() - 60 * 60000;
    for (let i = 0; i < 5; i++) await bot.watchdogTick();
    check(`${status} untouched`, bot.client === c && reinits.length === 0);
  }
}

console.log('\n7. A browser whose destroy() hangs still gets restarted');
{
  const c = stubClient({ state: 'TIMEOUT', hangDestroy: true });
  reset(c, 'CONNECTED');
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a);
  try {
    for (let i = 0; i < 3; i++) await bot.watchdogTick();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  check('re-init scheduled despite a wedged destroy()', reinits.length === 1 && bot.client === null);
}

console.log('\n8. Logout in progress is never interfered with');
{
  const c = stubClient({ state: 'TIMEOUT' });
  reset(c, 'CONNECTED');
  bot.loggingOut = true;
  for (let i = 0; i < 5; i++) await bot.watchdogTick();
  check('no watchdog restart during logout', bot.client === c && reinits.length === 0);
  bot.loggingOut = false;
}

bot.client = null;
if (bot.watchdogTimer) clearInterval(bot.watchdogTimer);
console.log(`\n${failed ? 'FAILED' : 'ALL CHECKS PASSED'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

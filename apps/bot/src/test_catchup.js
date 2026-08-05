/**
 * Missed-message catch-up regression suite — `npm run test-catchup`.
 *
 * Drives the REAL catchup service against a stubbed WhatsApp client and a stubbed AI, so it
 * exercises the actual code with no network, no LLM spend, and no WhatsApp session.
 *
 * Proves: the sweep finds every chat where the customer spoke last, splits them correctly by
 * age, answers recent ones at once, persists the old backlog across a restart, drips it out
 * only when no live customer is mid-conversation, tells the agent to apologise for stale
 * messages, drops queued items for anyone who starts talking live, and never answers the
 * same person twice.
 *
 * ⚠️ Guards a subtle regression that shipped once already: draining tier 1 by re-reading the
 * queue returns the OLDEST items, so the entire old backlog went out at full speed — the
 * exact burst the drip exists to prevent. Keep the "answers once the line is clear" and
 * "month-old flagged as delayed" checks.
 *
 * Writes to the real data store, so it resets the watermark and queue on entry AND exit.
 */
process.env.CATCHUP_DRAIN_PER_HOUR = '4';   // tiny, so the ceiling is observable
process.env.CATCHUP_DRAIN_BATCH = '2';
process.env.CATCHUP_TICK_MS = '999999';     // we call drainTick() manually

const dbService = (await import('./services/db.js')).default;
const aiService = (await import('./services/ai.js')).default;
const catchup = (await import('./services/catchup.js')).default;

// The suite writes to the real store, so wipe its own traces on the way in AND out —
// a leftover watermark would make the next real boot skip a genuine backlog.
const reset = async () => {
  await dbService.setMeta('catchup:lastSeenTs', 0);
  for (const it of await dbService.getCatchupBatch(9999)) {
    await dbService.deleteCatchupItem(it.messageId);
  }
};
await reset();

// --- stub the AI so no real LLM calls happen ---------------------------------
const asked = [];
aiService.answerQuery = async (chatId, query, name, phone) => {
  asked.push({ chatId, query });
  return { replyText: 'stub reply', intent: 'test', suggestedProductIds: [], requiresEscalation: false };
};

// --- stub bot ----------------------------------------------------------------
const sends = [];
const nowSec = Math.floor(Date.now() / 1000);
const mkChat = (num, hoursAgo, body, fromMe = false) => ({
  isGroup: false, isChannel: false,
  id: { _serialized: `${num}@c.us` },
  name: `Cust ${num}`,
  lastMessage: {
    id: { _serialized: `msg_${num}_${hoursAgo}` },
    fromMe, timestamp: nowSec - Math.round(hoursAgo * 3600), body, hasMedia: false,
  },
});

// A chat WhatsApp has NOT hydrated: no readable message in the local store, but an unread
// badge — so a customer IS waiting and we simply cannot see their text yet. Real accounts
// have hundreds of unhydrated chats, so getting this wrong silently drops customers.
const unhydrated = {
  id: { _serialized: '9116@c.us' }, name: 'Cust 9116', isGroup: false,
  lastMessage: null, unreadCount: 2, t: nowSec - 3600,
};

const chats = [
  mkChat('9111', 0.5, 'recent one'),           // tier 1
  mkChat('9112', 3, 'also recent'),            // tier 1
  mkChat('9113', 40, 'two days ago'),          // tier 2
  mkChat('9114', 24 * 30, 'a month ago'),      // tier 2
  mkChat('9115', 2, 'we already replied', true), // fromMe -> skip
  unhydrated,                                   // unread but unreadable -> must be rescued
  { isGroup: true, id: { _serialized: '123@g.us' }, lastMessage: { fromMe: false, timestamp: nowSec, body: 'group' } },
];

// The flat shape the page-level reader returns. Mirrors what listChatSummaries() extracts
// straight from the WhatsApp chat store, so sweep() is tested against its PRIMARY input,
// not just the library-helper fallback.
const asSummary = (c) => ({
  id: c.id._serialized,
  isGroup: Boolean(c.isGroup),
  isChannel: false,
  name: c.name || null,
  unreadCount: c.unreadCount !== undefined
    ? c.unreadCount
    : (c.lastMessage && !c.lastMessage.fromMe ? 1 : 0),
  chatTs: c.lastMessage?.timestamp || c.t || 0,
  lastId: c.lastMessage?.id?._serialized || null,
  lastFromMe: c.lastMessage ? Boolean(c.lastMessage.fromMe) : null,
  lastTs: c.lastMessage?.timestamp || 0,
  lastBody: c.lastMessage?.body || '',
  lastHasMedia: Boolean(c.lastMessage?.hasMedia),
});

// `pupPage.evaluate` runs its callback inside the browser, so it can't execute here — the
// stub just returns what that code would have produced.
let pageReadFails = false;
const bot = {
  status: 'CONNECTED',
  senderChains: new Map(),
  client: {
    pupPage: {
      evaluate: async () => {
        if (pageReadFails) throw new Error('Execution context was destroyed');
        return { fatal: null, failed: 0, chats: chats.map(asSummary) };
      },
    },
    // The library helper. All-or-nothing by design — this is the call that died with a
    // minified `r` on a live LID account, which is why it is only the fallback now.
    getChats: async () => chats,
    // Used only to rescue an unhydrated chat: pull the customer's real message on demand.
    getChatById: async (id) => (id !== '9116@c.us' ? null : {
      fetchMessages: async () => ([
        { fromMe: false, body: 'older question', hasMedia: false, timestamp: nowSec - 7200 },
        { fromMe: true, body: 'our old reply', hasMedia: false, timestamp: nowSec - 5400 },
        { fromMe: false, body: 'fetched on demand', hasMedia: false, timestamp: nowSec - 3600 },
      ]),
    }),
  },
  sendText: async (to, text) => { sends.push({ to, text }); return {}; },
};

const line = (s) => console.log('\n──── ' + s + ' ' + '─'.repeat(Math.max(0, 56 - s.length)));
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  return ok;
};
let fails = 0;
const must = (...a) => { if (!check(...a)) fails++; };

// --- 1. sweep ----------------------------------------------------------------
line('1. Sweep finds missed customers and splits them by age');
catchup.start(bot);
const sweep = await catchup.sweep();
must('read the chat store directly, not via getChats()', sweep.source, 'direct');
// The unhydrated chat is 1h old, so it lands in tier 1 alongside the two readable ones.
must('recent (tier 1) queued', sweep.fresh, 3);
must('older (tier 2) queued', sweep.backlog, 2);
must('unread-but-unreadable chat rescued, not skipped', sweep.skipped.unreadNoBody, 1);
must('tier 1 answered immediately', asked.length, 3);
must(
  'rescued chat had its real message fetched on demand',
  asked.some((a) => a.chatId === '9116@c.us' && a.query.includes('fetched on demand')),
  true
);
must('group chat ignored', chats.filter(c => c.isGroup).length && !asked.some(a => a.chatId.includes('@g.us')), true);
must('chat we already replied to skipped', asked.some(a => a.chatId.startsWith('9115')), false);
const ownerAlert = sends.find(s => s.text.includes('Missed messages found'));
must('owner alerted', Boolean(ownerAlert), true);
console.log('\n  Owner received:\n' + ownerAlert.text.split('\n').map(l => '    | ' + l).join('\n'));

// --- 2. backlog survives a restart -------------------------------------------
line('2. Backlog survives a restart (persisted, not in memory)');
const persisted = await dbService.getCatchupBatch(99);
must('2 older customers still queued after tier 1 drained', persisted.length, 2);
must('oldest is first in line', persisted[0].chatId, '9114@c.us');

// --- 3. live message cancels a queued reply ----------------------------------
line('3. A customer who messages live is removed from the queue');
catchup.forgetChat('9113@c.us');
await new Promise(r => setTimeout(r, 120));
const afterForget = await dbService.getCatchupBatch(99);
must('queued item dropped for the live chat', afterForget.map(i => i.chatId), ['9114@c.us']);

// --- 4. drip respects live traffic and the hourly ceiling --------------------
line('4. Drip yields to live traffic, then answers with an apology');
bot.senderChains.set('someone@c.us', Promise.resolve());
const before = asked.length;
await catchup.drainTick();
must('does nothing while a live customer is mid-conversation', asked.length, before);

bot.senderChains.clear();
await catchup.drainTick();
must('answers once the line is clear', asked.length, before + 1);
const old = asked[asked.length - 1];
must('month-old message flagged as delayed to the agent', old.query.includes('has been waiting') && old.query.includes('apologising'), true);
console.log('    agent was told: "' + old.query.split('\n')[0].slice(0, 96) + '…"');

// --- 5. queue empties and is announced ---------------------------------------
line('5. Queue empties and the owner is told');
await catchup.drainTick();
const stats = await dbService.getCatchupStats();
must('queue is empty', stats.pending, 0);
must('"backlog cleared" sent', sends.some(s => s.text.includes('Backlog cleared')), true);

// --- 6. re-sweep does not re-answer anyone -----------------------------------
line('6. A second sweep does not re-answer anyone (watermark holds)');
const askedBefore = asked.length;
const sweep2 = await catchup.sweep();
must('nothing new queued', sweep2.fresh + sweep2.backlog, 0);
must('nobody answered twice', asked.length, askedBefore);

// --- 7. the live failure that shipped: page read dies -> must not lose the sweep --------
line('7. If the direct read fails, the sweep falls back instead of dying');
await reset();
catchup.announcedEmpty = true;
pageReadFails = true;
const sweep3 = await catchup.sweep();
must('fell back to the library helper', sweep3 && sweep3.source, 'getChats');
must('still found the same customers', sweep3.fresh + sweep3.backlog, 4);
pageReadFails = false;

// --- 8. a chat the shop already replied to is never re-answered ------------------------
line('8. Diagnostics explain WHY chats were passed over');
must('counted the chat we had already replied to', sweep3.skipped.weRepliedLast, 1);
must('counted the group chat', sweep3.skipped.group, 1);

await reset();

console.log('\n' + '='.repeat(64));
console.log(fails === 0 ? '  ALL CHECKS PASSED' : `  ${fails} CHECK(S) FAILED`);
console.log('='.repeat(64));
process.exit(fails === 0 ? 0 : 1);

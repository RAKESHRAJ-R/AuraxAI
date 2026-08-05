import config from '../config/config.js';
import dbService from './db.js';
import aiService from './ai.js';

/**
 * Missed-message catch-up.
 *
 * THE PROBLEM THIS SOLVES
 * whatsapp-web.js only emits its 'message' event for messages that arrive LIVE while the
 * client is connected — every emit path is behind `if (!msg.isNewMsg) return` in Client.js.
 * Two whole classes of customer therefore never reach the bot at all:
 *
 *   1. Chats already unread on the phone when the number was first paired.
 *   2. Anything sent while the server was down, restarting, or disconnected.
 *
 * Neither produces an error or a log line. The customer simply never gets a reply, which is
 * exactly the outcome the store cannot afford.
 *
 * THE APPROACH
 * On every 'ready', sweep the chat list and find every chat where the CUSTOMER spoke last
 * and their message is newer than our watermark — that is precisely the definition of "we
 * owe this person a reply". Missed chats are split into two tiers:
 *
 *   Tier 1 (within freshHours) — answered right away at normal pace. They are still waiting.
 *   Tier 2 (older)             — persisted to a queue and dripped out slowly.
 *
 * The drip is the part that matters for account safety. Answering a thousand-chat backlog at
 * full speed is the single most bannable thing an unofficial client can do, so tier 2 goes out
 * at a strict per-hour rate, yields to live customers, and never bursts.
 *
 * THE WATERMARK
 * The newest message timestamp we have definitely handled, persisted on every processed
 * message. It is what makes a restart cheap: we sweep forward from it rather than
 * re-examining history. It is deliberately only ever moved FORWARD.
 */

const WATERMARK_KEY = 'catchup:lastSeenTs';
const MAX_ATTEMPTS = 3;          // give up on an item that keeps failing rather than block the queue
const MAX_CONTEXT_CHARS = 1000;

class CatchupService {
  constructor() {
    this.bot = null;             // injected — avoids an import cycle with whatsapp-web-bot.js
    this.drainTimer = null;
    this.sweeping = false;
    this.draining = false;
    this.lastSweep = null;
    this.sentThisHour = [];      // rolling timestamps, for the per-hour drip ceiling
    this.announcedEmpty = true;  // so "backlog cleared" is announced once, not every tick
  }

  /** Called once at startup with the bot instance. Safe to call repeatedly. */
  start(bot) {
    this.bot = bot;
    if (!config.catchup.enabled) {
      console.log('[Catch-up] Disabled by config — missed messages will NOT be answered.');
      return;
    }
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => this.drainTick(), config.catchup.tickMs);
    this.drainTimer.unref?.();
    console.log(
      `[Catch-up] Enabled. Fresh window ${config.catchup.freshHours}h, ` +
      `backlog drip ${config.catchup.drainPerHour}/hour.` +
      (config.catchup.dryRun ? ' ⚠️  DRY RUN — will report only, nobody will be messaged.' : '')
    );
  }

  /**
   * Move the watermark forward. Called for every message the bot handles, live or caught up,
   * so the next sweep starts from the right place even after an unclean shutdown.
   * @param {number} tsSeconds WhatsApp message timestamp (unix SECONDS)
   */
  async noteHandled(tsSeconds) {
    if (!tsSeconds) return;
    try {
      const current = await dbService.getMeta(WATERMARK_KEY, 0);
      if (tsSeconds > current) await dbService.setMeta(WATERMARK_KEY, tsSeconds);
    } catch (err) {
      console.warn('[Catch-up] Could not update watermark:', err.message);
    }
  }

  /**
   * List every chat as a flat summary: { id, isGroup, name, unreadCount, lastFromMe, lastTs, … }.
   *
   * Deliberately NOT `client.getChats()`. That helper maps every chat through
   * `WWebJS.getChatModel` inside a single `Promise.all`, and that model builder does a
   * network `groupMetadata.update()` per group plus LID-migration lookups per participant.
   * ONE chat throwing rejects the whole batch, so the entire sweep dies with a minified
   * `r` and every waiting customer is silently skipped — observed live 2026-08-05 on a
   * LID-based account ("[Catch-up] Could not list chats: r").
   *
   * This reads the same underlying Chat collection but pulls only the handful of fields the
   * sweep actually needs, with a try/catch around EACH chat so one unreadable conversation
   * costs exactly one conversation. It is also far cheaper: no metadata fetches, no contact
   * resolution, no Message/Chat class construction for a thousand chats.
   */
  async listChatSummaries(limit) {
    const page = this.bot?.client?.pupPage;
    // No page means we can't read the store directly — use the library helper rather than
    // reporting "no chats", which would look identical to an account with nothing waiting.
    if (!page) return this.listChatsFallback(limit);

    try {
      const res = await page.evaluate((max) => {
        let Chat, Msg;
        try {
          const collections = window.require('WAWebCollections');
          Chat = collections.Chat;
          Msg = collections.Msg;
        } catch (err) {
          return { fatal: 'WAWebCollections unavailable: ' + err.message, chats: [], failed: 0 };
        }

        const chats = [];
        let failed = 0;
        const models = Chat.getModelsArray() || [];

        for (const chat of models) {
          if (chats.length >= max) break;
          try {
            const id = chat.id?._serialized || '';
            if (!id) continue;

            // Last message: prefer the chat's own pointer, fall back to the newest loaded
            // model. Either can be absent on a chat WhatsApp hasn't hydrated yet.
            let last = null;
            try {
              const key = chat.lastReceivedKey?._serialized;
              if (key) last = Msg.get(key) || null;
            } catch { /* fall through */ }
            if (!last) {
              try {
                const arr = chat.msgs?.getModelsArray?.() || [];
                for (let i = arr.length - 1; i >= 0; i--) {
                  if (arr[i] && !arr[i].isNotification) { last = arr[i]; break; }
                }
              } catch { /* leave null */ }
            }

            chats.push({
              id,
              isGroup: id.endsWith('@g.us') || Boolean(chat.groupMetadata),
              isChannel: id.endsWith('@newsletter') || Boolean(chat.newsletterMetadata),
              name: chat.formattedTitle || chat.name || null,
              unreadCount: chat.unreadCount || 0,
              chatTs: chat.t || 0,
              lastId: last?.id?._serialized || null,
              lastFromMe: last ? Boolean(last.id?.fromMe) : null,
              lastTs: last?.t || 0,
              // Media messages carry their text in `caption`, plain ones in `body`.
              lastBody: last ? String(last.caption || last.body || '') : '',
              lastHasMedia: last ? Boolean(last.directPath || last.mediaKey) : false,
            });
          } catch {
            failed++;
          }
        }
        return { fatal: null, chats, failed };
      }, limit);

      if (res.fatal) {
        console.warn('[Catch-up] Direct chat read failed (' + res.fatal + ') — falling back.');
        return this.listChatsFallback(limit);
      }
      if (res.failed) {
        console.warn(`[Catch-up] ${res.failed} chat(s) could not be read and were skipped.`);
      }
      return { chats: res.chats, failed: res.failed, source: 'direct' };
    } catch (err) {
      console.warn('[Catch-up] Direct chat read threw (' + err.message + ') — falling back.');
      return this.listChatsFallback(limit);
    }
  }

  /** Last resort: the library helper. All-or-nothing, but better than giving up entirely. */
  async listChatsFallback(limit) {
    try {
      const raw = await this.bot.client.getChats();
      const chats = raw.slice(0, limit).map((c) => ({
        id: c.id?._serialized || '',
        isGroup: Boolean(c.isGroup),
        isChannel: Boolean(c.isChannel),
        name: c.name || null,
        unreadCount: c.unreadCount || 0,
        chatTs: c.timestamp || 0,
        lastId: c.lastMessage?.id?._serialized || null,
        lastFromMe: c.lastMessage ? Boolean(c.lastMessage.fromMe) : null,
        lastTs: c.lastMessage?.timestamp || 0,
        lastBody: c.lastMessage?.body || '',
        lastHasMedia: Boolean(c.lastMessage?.hasMedia),
      }));
      return { chats, failed: 0, source: 'getChats' };
    } catch (err) {
      console.error('[Catch-up] Could not list chats at all:', err.message);
      return { chats: [], failed: 0, source: 'failed' };
    }
  }

  /**
   * Forget any queued items for a chat that has just gone live. Fire-and-forget on purpose —
   * it must never add latency to answering a real customer.
   */
  forgetChat(chatId) {
    if (!config.catchup.enabled || !chatId) return;
    dbService.deleteCatchupByChat(chatId)
      .catch((err) => console.warn('[Catch-up] Could not clear queued items:', err.message));
  }

  /**
   * Scan every chat for customers we owe a reply to, and queue them.
   *
   * Uses `chat.lastMessage` rather than fetching each chat's history: if the last message in
   * a chat is from us, that conversation is already answered, and if it is from the customer
   * and newer than the watermark, that IS the message to reply to. One pass over getChats()
   * with no per-chat round trip, which keeps a 1000-chat sweep to seconds instead of minutes.
   */
  async sweep() {
    if (!config.catchup.enabled || this.sweeping || !this.bot?.client) return null;
    this.sweeping = true;
    const startedAt = Date.now();

    try {
      const watermark = await dbService.getMeta(WATERMARK_KEY, 0);
      const nowSec = Math.floor(Date.now() / 1000);
      const freshCutoff = nowSec - config.catchup.freshHours * 3600;
      const ageLimit = config.catchup.maxAgeDays > 0
        ? nowSec - config.catchup.maxAgeDays * 86400
        : 0;

      const { chats, source } = await this.listChatSummaries(config.catchup.maxChatsScanned);
      if (!chats.length) {
        console.warn('[Catch-up] No chats readable — nothing swept.');
        return null;
      }

      const fresh = [];
      const backlog = [];
      let tooOld = 0;
      // Why each chat was passed over. A sweep that queues nothing is indistinguishable from
      // a sweep that silently failed unless it can say WHICH filter rejected everything —
      // which is exactly the question asked when this feature first shipped broken.
      // `noMessage` (nothing pending) is harmless — an old chat WhatsApp hasn't hydrated.
      // `unreadNoBody` is NOT: the chat carries an unread badge, so a customer IS waiting,
      // we just can't see their text from the store. Those must be rescued, not skipped.
      const skip = { group: 0, noMessage: 0, unreadNoBody: 0, weRepliedLast: 0, alreadyHandled: 0, empty: 0 };

      for (const chat of chats) {
        // Groups, channels and status broadcasts are never customer conversations.
        if (chat.isGroup || chat.isChannel) { skip.group++; continue; }
        const id = chat.id;
        if (!id.endsWith('@c.us') && !id.endsWith('@lid')) { skip.group++; continue; }

        // No readable message. If the chat also carries no unread badge, nobody is waiting
        // and skipping is correct. If it DOES have unread messages, a customer is waiting
        // and the text simply isn't in the local store yet — flag it to be fetched lazily
        // at reply time rather than dropping the customer.
        const unread = chat.unreadCount || 0;
        let needsFetch = false;
        if (!chat.lastId && !chat.lastTs) {
          if (unread <= 0) { skip.noMessage++; continue; }
          skip.unreadNoBody++;
          needsFetch = true;
        }
        // We spoke last → this conversation is already answered. This is what stops the
        // sweep re-replying to chats a human on the shop phone has already handled.
        // An unread badge overrides it: the customer has written again since.
        if (chat.lastFromMe && unread <= 0) { skip.weRepliedLast++; continue; }
        if (chat.lastFromMe && unread > 0) needsFetch = true;

        const ts = chat.lastTs || chat.chatTs || 0;
        if (ts <= watermark) { skip.alreadyHandled++; continue; }
        if (ageLimit && ts < ageLimit) { tooOld++; continue; }

        const body = (chat.lastBody || '').trim();
        if (!body && !chat.lastHasMedia && !needsFetch) {
          if (unread > 0) { skip.unreadNoBody++; needsFetch = true; }
          else { skip.empty++; continue; }
        }

        const isFresh = ts >= freshCutoff;
        const item = {
          messageId: chat.lastId || `${id}:${ts}`,
          chatId: id,
          name: chat.name || 'Customer',
          body: body.slice(0, MAX_CONTEXT_CHARS),
          hasMedia: Boolean(chat.lastHasMedia),
          timestamp: ts,
          // The store had no usable text for this one. processItem() pulls the real
          // message from WhatsApp just before replying — deferred so the sweep stays a
          // single fast pass instead of hundreds of per-chat round trips.
          needsFetch,
          unreadCount: unread,
          // 0 = still-waiting customer, 1 = old backlog. Drives BOTH the drip ordering and
          // crash recovery: if we die mid-sweep, a tier-0 item must still be treated as
          // urgent on the next run rather than sinking to the back of an oldest-first queue.
          tierRank: isFresh ? 0 : 1,
        };

        (isFresh ? fresh : backlog).push(item);
      }

      // Dry run stops here: report what WOULD happen, touch nothing, message nobody.
      if (config.catchup.dryRun) {
        const sample = [...fresh, ...backlog]
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, 10);
        console.log(
          `[Catch-up] DRY RUN — would answer ${fresh.length} recent and ` +
          `${backlog.length} older customer(s)${tooOld ? `, skipping ${tooOld} past the age limit` : ''}. ` +
          'Nothing was sent or queued.'
        );
        console.log(
          `[Catch-up] DRY RUN — passed over: ${skip.weRepliedLast} already replied to, ` +
          `${skip.alreadyHandled} handled earlier, ${skip.group} groups/channels, ` +
          `${skip.noMessage} idle-unhydrated, ${skip.empty} empty. Rescued ${skip.unreadNoBody} unread-but-unreadable. (read via ${source})`
        );
        for (const s of sample) {
          const hrs = ((nowSec - s.timestamp) / 3600).toFixed(1);
          console.log(
            `[Catch-up] DRY RUN — +${String(s.chatId).replace(/[^0-9]/g, '')} ` +
            `waited ${hrs}h: "${s.body.slice(0, 60).replace(/\s+/g, ' ')}"`
          );
        }
        this.lastSweep = {
          at: new Date().toISOString(), dryRun: true, chatsScanned: chats.length, source,
          fresh: fresh.length, backlog: backlog.length, tooOld, skipped: skip,
          tookMs: Date.now() - startedAt,
        };
        return this.lastSweep;
      }

      // Persist BEFORE answering anything, so a crash mid-catch-up loses nobody.
      const queuedBacklog = await dbService.queueCatchupItems(backlog);
      const queuedFresh = await dbService.queueCatchupItems(fresh);

      this.lastSweep = {
        at: new Date().toISOString(),
        chatsScanned: chats.length,
        source,
        fresh: queuedFresh,
        backlog: queuedBacklog,
        tooOld,
        skipped: skip,
        tookMs: Date.now() - startedAt,
      };

      const total = queuedFresh + queuedBacklog;
      if (total > 0) this.announcedEmpty = false;

      console.log(
        `[Catch-up] Swept ${chats.length} chats (via ${source}) in ${this.lastSweep.tookMs}ms — ` +
        `${queuedFresh} recent, ${queuedBacklog} older queued` +
        (tooOld ? `, ${tooOld} beyond the age limit` : '') + '.'
      );
      console.log(
        `[Catch-up] Passed over: ${skip.weRepliedLast} already replied to, ` +
        `${skip.alreadyHandled} handled in an earlier run, ${skip.group} groups/channels, ` +
        `${skip.noMessage} idle-unhydrated, ${skip.empty} empty; rescued ${skip.unreadNoBody} unread-but-unreadable.`
      );

      // Answer the still-waiting customers now, without waiting for the drip timer.
      if (fresh.length) await this.drainFresh(fresh);
      if (total > 0) this.alertSweep(total, queuedFresh, queuedBacklog, tooOld);

      return this.lastSweep;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Drain tier-1 items straight away. They still go through the bot's global send pacer, so
   * "immediately" means ~1.7s apart, not all at once.
   *
   * Takes the sweep's own list rather than re-reading the queue. Reading it back would return
   * the OLDEST items first — i.e. the tier-2 backlog — and answer the whole thing at full
   * speed, which is the exact burst this design exists to avoid. (Caught by the test suite;
   * the items are already persisted by this point, so crash-safety is unaffected.)
   */
  async drainFresh(items) {
    for (const item of items) {
      await this.processItem(item, { silentAge: true });
    }
  }

  /**
   * The slow drip. Runs on a timer and is deliberately timid: it does nothing while live
   * customers are mid-conversation, so real-time traffic always wins.
   */
  async drainTick() {
    if (!config.catchup.enabled || config.catchup.dryRun || this.draining || !this.bot?.client) return;
    if (this.bot.status !== 'CONNECTED') return;

    // Yield to live traffic. senderChains is non-empty exactly while real customers are
    // being processed, so backlog work simply waits for a quiet moment.
    if (this.bot.senderChains?.size > 0) return;

    // Per-hour ceiling.
    const hourAgo = Date.now() - 3600 * 1000;
    this.sentThisHour = this.sentThisHour.filter((t) => t > hourAgo);
    const remaining = config.catchup.drainPerHour - this.sentThisHour.length;
    if (remaining <= 0) return;

    this.draining = true;
    try {
      const batch = await dbService.getCatchupBatch(Math.min(config.catchup.drainBatch, remaining));
      if (!batch.length) {
        if (!this.announcedEmpty) {
          this.announcedEmpty = true;
          console.log('[Catch-up] Backlog fully drained — every missed customer has been answered.');
          this.alertDrained();
        }
        return;
      }
      for (const item of batch) {
        await this.processItem(item);
        this.sentThisHour.push(Date.now());
      }
    } catch (err) {
      console.error('[Catch-up] Drain tick failed:', err.message);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Answer one missed customer, then remove them from the queue.
   *
   * The item is only deleted after a SUCCESSFUL send — a crash between answering and
   * deleting would re-answer someone, which is far better than never answering them, and
   * the attempt counter stops a permanently-broken item spinning forever.
   */
  async processItem(item, { silentAge = false } = {}) {
    const phone = String(item.chatId).replace(/[^0-9]/g, '');

    // Safe mode applies here exactly as it does to live messages, or a staging server
    // would happily answer every real customer in the backlog.
    const allowed = config.wati.allowedTestNumbers;
    if (allowed && allowed.length > 0 && !allowed.includes(phone)) {
      await dbService.deleteCatchupItem(item.messageId);
      return;
    }

    if ((item.attempts || 0) >= MAX_ATTEMPTS) {
      console.warn(`[Catch-up] Giving up on ${phone} after ${item.attempts} attempts.`);
      await dbService.deleteCatchupItem(item.messageId);
      return;
    }

    const ageHours = Math.max(0, (Date.now() / 1000 - item.timestamp) / 3600);

    try {
      let body = item.body || '';
      // The chat store had no readable text at sweep time (WhatsApp hadn't hydrated that
      // conversation). Pull it now, one chat at a time — this runs at the drip rate, so it
      // costs nothing at sweep time and never floods the browser with round trips.
      if (item.needsFetch) {
        const fetched = await this.fetchLatestInbound(item.chatId);
        if (fetched?.body) body = fetched.body;
        if (fetched?.timestamp) item.timestamp = fetched.timestamp;
        if (!body && !fetched?.hasMedia) {
          // Genuinely nothing to answer — an empty or system-only chat. Drop it rather
          // than sending a reply to a message we never saw.
          console.log(`[Catch-up] Nothing readable for ${phone} — dropping.`);
          await dbService.deleteCatchupItem(item.messageId);
          return;
        }
      }

      let query = body || '[The customer sent a photo/image.]';
      // Answering a days-old message as though it just arrived reads badly and invites a
      // block. Tell the agent how stale it is so it can open by acknowledging the delay.
      if (!silentAge && ageHours >= 24) {
        const days = Math.round(ageHours / 24);
        query =
          `[This message has been waiting ${days} day${days === 1 ? '' : 's'} for a reply. ` +
          `Open by briefly apologising for the delayed response, then help them normally. ` +
          `Do not pretend it just arrived.]\n\n${query}`;
      }

      const res = await aiService.answerQuery(item.chatId, query, item.name, phone, {
        hasMedia: item.hasMedia,
      });

      await this.bot.sendText(item.chatId, res.replyText);
      await this.noteHandled(item.timestamp);
      await dbService.deleteCatchupItem(item.messageId);
      console.log(`[Catch-up] Answered ${phone} (waited ${ageHours.toFixed(1)}h).`);
    } catch (err) {
      console.error(`[Catch-up] Failed for ${phone}:`, err.message);
      await dbService.bumpCatchupAttempt(item.messageId);
    }
  }

  /**
   * Pull the customer's most recent message straight from WhatsApp for one chat.
   *
   * Used only for chats whose messages were not in the local store at sweep time. Returns
   * null on any failure — a chat we cannot read must not take the whole catch-up down.
   */
  async fetchLatestInbound(chatId) {
    try {
      const chat = await this.bot.client.getChatById(chatId);
      if (!chat) return null;
      const msgs = await chat.fetchMessages({ limit: 6 });
      if (!msgs?.length) return null;

      // Walk backwards to the newest message the CUSTOMER sent. Anything after a reply of
      // ours is what they said last, which is what we owe an answer to.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.fromMe) continue;
        const text = (m.body || '').trim();
        if (!text && !m.hasMedia) continue;
        return {
          body: text.slice(0, MAX_CONTEXT_CHARS),
          hasMedia: Boolean(m.hasMedia),
          timestamp: m.timestamp || 0,
        };
      }
      return null;
    } catch (err) {
      console.warn(`[Catch-up] Could not fetch messages for ${chatId}: ${err.message}`);
      return null;
    }
  }

  // --- Owner notifications ---

  alertSweep(total, fresh, backlog, tooOld) {
    if (!config.catchup.alertOwner) return;
    const hours = Math.max(1, Math.ceil(backlog / Math.max(1, config.catchup.drainPerHour)));
    const lines = [
      '📥 *Missed messages found*',
      '',
      `The bot reconnected and found *${total}* customer${total === 1 ? '' : 's'} waiting for a reply.`,
      '',
      `• ${fresh} recent — being answered now`,
      `• ${backlog} older — queued, going out gradually${backlog ? ` (about ${hours}h)` : ''}`,
    ];
    if (tooOld) lines.push(`• ${tooOld} beyond the age limit — not answered`);
    lines.push('', 'Spread out on purpose so the number stays safe.');
    this.notifyOwner(lines.join('\n'));
  }

  alertDrained() {
    if (!config.catchup.alertOwner) return;
    this.notifyOwner('✅ *Backlog cleared* — every missed customer has now been answered.');
  }

  notifyOwner(text) {
    const owner = (config.owner?.whatsappNumber || '').replace(/[^0-9]/g, '');
    if (!owner || !this.bot || this.bot.status !== 'CONNECTED') return;
    this.bot.sendText(`${owner}@c.us`, text)
      .catch((err) => console.error('[Catch-up] Owner alert failed:', err.message));
  }

  async getStatus() {
    const stats = await dbService.getCatchupStats();
    return {
      enabled: config.catchup.enabled,
      freshHours: config.catchup.freshHours,
      drainPerHour: config.catchup.drainPerHour,
      pending: stats.pending,
      oldestWaitingSince: stats.oldestTimestamp
        ? new Date(stats.oldestTimestamp * 1000).toISOString()
        : null,
      lastSweep: this.lastSweep,
    };
  }
}

const catchupService = new CatchupService();
export default catchupService;

import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import config from '../config/config.js';
import aiService from './ai.js';

const { Client, LocalAuth, MessageMedia } = pkg;

class WhatsAppWebBot {
  constructor() {
    this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
    this.qrDataUrl = null;
    this.client = null;
    // Which WhatsApp account is currently linked — captured on 'ready' and surfaced in the
    // admin console. Without this, nobody can tell WHOSE phone the bot is paired to without
    // physically checking every candidate device's "Linked devices" screen.
    this.deviceInfo = null;
    this.connectedAt = null;
    // Single pending re-init timer. Both the 'disconnected' handler and logout() want to
    // bring the client back up; if each sets its own setTimeout we end up launching TWO
    // Puppeteer/WhatsApp clients against one LocalAuth session, which corrupts it.
    this.reinitTimer = null;
    this.loggingOut = false;
    // Per-sender processing chains: a global concurrency-N pool (the old approach)
    // can dequeue two messages from the SAME customer onto different workers at once,
    // and since answerQuery does a read-modify-write on that customer's session, the
    // two calls race and one update silently disappears (e.g. "size M" then "qty 3"
    // sent seconds apart — one of them gets lost). Chaining per senderId guarantees
    // strict in-order processing for a given customer while different customers still
    // run fully in parallel.
    this.senderChains = new Map();
    // whatsapp-web.js occasionally re-emits the same inbound message (reconnects,
    // session resync) with no dedupe of its own — without this, a replayed 'message'
    // event runs the full agent + LLM call twice and sends two near-identical replies
    // for what the customer only sent once. Capped FIFO so it can't grow unbounded
    // in a long-running process.
    this.seenMessageIds = new Set();
    // --- Outbound send pacing (ban-risk protection) ---
    // WhatsApp rate-limits and bans per ACCOUNT, not per chat, so pacing has to be
    // global across every customer AND every owner alert. sendChain serialises all
    // outbound sends into one queue; each one takes its turn and only then checks the
    // clock. (Checking the clock in parallel is the classic mistake — N callers all
    // read the same "last send" timestamp, all wait the same amount, then all fire
    // together, which is no rate limit at all.)
    this.sendChain = Promise.resolve();
    this.lastSendAt = 0;
    // Rolling 60s window of send timestamps, for the per-minute ceiling.
    this.sendWindow = [];
  }

  /**
   * The ONLY place that may call client.sendMessage. Serialises every outbound message
   * behind a single global queue and paces it (min gap + jitter + per-minute ceiling)
   * so a 100-customer burst goes out at a human rate instead of all at once.
   *
   * Returns the underlying sendMessage promise, so callers can still await/catch it.
   * A failed send never breaks the queue for the messages behind it.
   */
  sendText(to, content, options = undefined) {
    const run = this.sendChain.then(async () => {
      if (!this.client) throw new Error('WhatsApp client not initialised');
      await this.awaitSendSlot();
      return options ? this.client.sendMessage(to, content, options)
                     : this.client.sendMessage(to, content);
    });
    // Swallow this send's outcome for chain-continuation purposes only — the caller
    // still sees the real result/rejection via `run`.
    this.sendChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Blocks until it's safe to send the next message. Called only from inside the
   * serialised sendChain, so the timestamps it reads and writes can't race.
   */
  async awaitSendSlot() {
    const cfg = config.whatsappWeb;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // 1) Rolling per-minute ceiling.
    const maxPerMin = cfg.maxSendsPerMinute;
    if (maxPerMin > 0) {
      this.sendWindow = this.sendWindow.filter(t => Date.now() - t < 60000);
      if (this.sendWindow.length >= maxPerMin) {
        const waitMs = 60000 - (Date.now() - this.sendWindow[0]) + 50;
        if (waitMs > 0) {
          console.log(`[WhatsApp] Send cap reached (${maxPerMin}/min) — holding ${Math.round(waitMs / 1000)}s.`);
          await sleep(waitMs);
          this.sendWindow = this.sendWindow.filter(t => Date.now() - t < 60000);
        }
      }
    }

    // 2) Minimum gap since the previous send, plus jitter so the cadence isn't robotic.
    const gap = cfg.minSendGapMs + Math.floor(Math.random() * (cfg.sendJitterMs || 0));
    const sinceLast = Date.now() - this.lastSendAt;
    if (this.lastSendAt && sinceLast < gap) {
      await sleep(gap - sinceLast);
    }

    this.lastSendAt = Date.now();
    this.sendWindow.push(this.lastSendAt);
  }

  /**
   * Holds a reply back so the total time from "customer sent" to "bot replied" never
   * looks inhumanly fast. Deterministic fast paths (FAQ, knowledge, size parsing) answer
   * in single-digit milliseconds — instant replies to everyone, around the clock, is one
   * of the clearest automation tells. Replies that already took longer than the target
   * (any LLM call) are sent immediately with no added delay, so this costs real customers
   * nothing on the slow paths.
   */
  async humanizeDelay(receivedAt, replyText = '') {
    const cfg = config.whatsappWeb;
    const lengthBonus = Math.min(
      (replyText || '').length * (cfg.replyDelayPerCharMs || 0),
      Math.max(cfg.maxReplyDelayMs - cfg.minReplyDelayMs, 0)
    );
    const target = cfg.minReplyDelayMs + lengthBonus + Math.floor(Math.random() * 400);
    const elapsed = Date.now() - receivedAt;
    if (elapsed < target) {
      await new Promise(r => setTimeout(r, target - elapsed));
    }
  }

  isDuplicateMessage(msg) {
    const msgId = msg.id?._serialized || msg.id?.id;
    if (!msgId) return false;
    if (this.seenMessageIds.has(msgId)) return true;
    this.seenMessageIds.add(msgId);
    if (this.seenMessageIds.size > 1000) {
      const oldest = this.seenMessageIds.values().next().value;
      this.seenMessageIds.delete(oldest);
    }
    return false;
  }

  enqueueMessage(msg) {
    const senderId = msg.from;
    const previous = this.senderChains.get(senderId) || Promise.resolve();
    const chain = previous
      .then(() => this.handleIncomingMessage(msg))
      .catch(err => console.error(`[Queue] Unhandled error processing message from ${senderId}:`, err.message))
      .finally(() => {
        if (this.senderChains.get(senderId) === chain) {
          this.senderChains.delete(senderId);
        }
      });
    this.senderChains.set(senderId, chain);
  }

  /**
   * Read the linked account off `client.info` into `deviceInfo`.
   *
   * Called on 'ready' AND lazily from getStatus(), because `client.info` is not reliably
   * populated at the moment 'ready' fires — observed in production 2026-08-05, where the
   * console showed a healthy CONNECTED session with "Unknown number"/"Linked since Never"
   * while the same build filled it in correctly locally. The server resolves LIDs
   * (`…@lid`) rather than plain phone JIDs, and `info` lands slightly later there. Reading
   * it again when the admin page polls costs nothing and closes that window.
   *
   * Returns the captured object, or null if there's still nothing to read.
   */
  captureDeviceInfo(source = 'lazy') {
    try {
      const info = this.client?.info;
      if (!info) return null;
      // The shape has moved between whatsapp-web.js versions — `me` is the older field.
      const wid = info.wid || info.me || {};
      const number = wid.user || wid._serialized?.split('@')[0] || null;
      if (!number && !info.pushname) return null;
      this.deviceInfo = {
        number,
        name: info.pushname || null,
        platform: info.platform || null,
        connectedAt: this.connectedAt || new Date().toISOString(),
      };
      if (source === 'ready') {
        console.log(`[WhatsApp Web Bot] Linked account: +${number || '?'}${info.pushname ? ` (${info.pushname})` : ''}`);
      }
      return this.deviceInfo;
    } catch (err) {
      console.warn('[WhatsApp Web Bot] Could not read linked-account info:', err.message);
      return null;
    }
  }

  /**
   * Queue a re-initialization, replacing any already-pending one. Every path that wants the
   * client back (disconnect, auth failure, launch failure, admin logout) MUST go through
   * here rather than calling setTimeout(initialize) directly — see reinitTimer above.
   */
  scheduleReinit(delayMs) {
    if (this.reinitTimer) clearTimeout(this.reinitTimer);
    this.reinitTimer = setTimeout(() => {
      this.reinitTimer = null;
      this.initialize();
    }, delayMs);
  }

  /**
   * Unlink the currently paired phone and come back up with a fresh QR.
   *
   * client.logout() revokes the session on the phone's side AND clears the LocalAuth folder,
   * which is the difference that matters: destroy() alone would just close the browser and
   * the next initialize() would silently re-pair the SAME number, so "logout" wouldn't log
   * anything out. The client reference is detached first so the 'disconnected' event this
   * triggers can't double-destroy or double-schedule behind us.
   */
  async logout() {
    if (!config.whatsappWeb.enabled) {
      return { ok: false, message: 'WhatsApp Web integration is disabled.' };
    }
    if (this.loggingOut) {
      return { ok: false, message: 'A logout is already in progress.' };
    }
    const client = this.client;
    if (!client) {
      return { ok: false, message: 'No active WhatsApp session to log out.' };
    }

    this.loggingOut = true;
    const previous = this.deviceInfo?.number || null;
    // Detach first: the 'disconnected' handler checks `this.client` and will now no-op.
    this.client = null;
    this.status = 'DISCONNECTED';
    this.qrDataUrl = null;
    this.deviceInfo = null;
    this.connectedAt = null;

    let cleared = true;
    try {
      await client.logout();
      console.log(`[WhatsApp Web Bot] Logged out${previous ? ` (was +${previous})` : ''}. Session cleared.`);
    } catch (err) {
      // logout() can throw if the page is already gone. The session files may then survive,
      // so say so honestly rather than reporting a clean unlink that didn't happen.
      cleared = false;
      console.warn('[WhatsApp Web Bot] logout() failed:', err.message);
    }
    try {
      await client.destroy();
    } catch {
      /* best-effort: the browser may already be closed */
    }

    this.loggingOut = false;
    // Short delay (not the 10s reconnect one) so the admin gets a new QR promptly.
    this.scheduleReinit(2000);
    return {
      ok: true,
      cleared,
      previousNumber: previous,
      message: cleared
        ? 'Logged out. A new QR code will appear in a few seconds.'
        : 'Session closed, but the stored login may not have been fully cleared — if the same number reconnects, delete apps/bot/.wwebjs_auth and restart.',
    };
  }

  initialize() {
    if (!config.whatsappWeb.enabled) {
      console.log('[WhatsApp Web Bot] Disabled in config. Skipping initialization.');
      return;
    }

    if (this.client) {
      console.log('[WhatsApp Web Bot] Client already exists. Skipping duplicate initialization.');
      return;
    }

    console.log('[WhatsApp Web Bot] Initializing client...');
    this.status = 'CONNECTING';

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: 'theaurax-bot'
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-features=NetworkService'
          ]
        }
      });

      this.client.on('qr', async (qr) => {
        console.log('[WhatsApp Web Bot] QR code received. Generating data URL...');
        this.status = 'QR_READY';
        try {
          this.qrDataUrl = await qrcode.toDataURL(qr);
        } catch (err) {
          console.error('[WhatsApp Web Bot] Failed to generate QR data URL:', err.message);
        }
      });

      this.client.on('ready', () => {
        console.log('[WhatsApp Web Bot] Client is ready and connected!');
        this.status = 'CONNECTED';
        this.qrDataUrl = null;
        // Record the connect time here even if the account details aren't readable yet —
        // otherwise "Linked since" shows "Never" on a perfectly healthy connection.
        this.connectedAt = new Date().toISOString();
        this.captureDeviceInfo('ready');
      });

      this.client.on('authenticated', () => {
        console.log('[WhatsApp Web Bot] Authenticated successfully.');
      });

      this.client.on('auth_failure', async (msg) => {
        console.error('[WhatsApp Web Bot] Authentication failed:', msg);
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.deviceInfo = null;
        this.connectedAt = null;
        try {
          await this.client?.destroy();
        } catch (err) {
          // ignore
        }
        this.client = null;
      });

      this.client.on('disconnected', async (reason) => {
        console.log('[WhatsApp Web Bot] Client disconnected:', reason);
        // logout() detaches this.client before triggering this event and handles its own
        // teardown + re-init, so bail out rather than fighting it for the same client.
        if (!this.client) return;
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.deviceInfo = null;
        this.connectedAt = null;
        try {
          await this.client.destroy();
        } catch (err) {
          // ignore
        }
        this.client = null;

        // Auto-reinitialize after 10 seconds
        this.scheduleReinit(10000);
      });

      this.client.on('message', async (msg) => {
        if (this.isDuplicateMessage(msg)) {
          console.log(`[WhatsApp] Duplicate 'message' event for id ${msg.id?._serialized || msg.id?.id} — skipping.`);
          return;
        }
        this.enqueueMessage(msg);
      });

      this.client.initialize().catch((error) => {
        console.error('[WhatsApp Web Bot] Failed to initialize client asynchronously:', error.message);
        this.status = 'DISCONNECTED';
        this.client = null;
        this.deviceInfo = null;
        this.connectedAt = null;
        // Auto-reinitialize after 10 seconds on failure
        this.scheduleReinit(10000);
      });
    } catch (error) {
      console.error('[WhatsApp Web Bot] Failed to initialize client:', error.message);
      this.status = 'DISCONNECTED';
      this.client = null;
    }
  }

  async handleIncomingMessage(msg) {
    let typingInterval = null;
    // When the customer's message landed — humanizeDelay() measures the reply turnaround
    // from here, so deterministic zero-latency answers don't go out instantly.
    const receivedAt = Date.now();
    try {
      // Ignore group chats, broadcast/status
      if (msg.isGroupMsg || msg.from.includes('@g.us') || msg.from === 'status@broadcast') {
        return;
      }

      // A message must have EITHER text or media. A photo of a damaged/wrong jersey
      // typically arrives with no caption (empty body) — previously that was dropped
      // silently, so the support flow never saw it. Accept media too.
      const hasMedia = !!msg.hasMedia;
      if (!msg.body && !hasMedia) return;

      const senderId = msg.from; // e.g. "919940954744@c.us"
      const normalizedSender = senderId.replace(/[^0-9]/g, '');
      console.log(`[DEBUG] Received raw message from: ${senderId} (Normalized: ${normalizedSender})`);

      // Retrieve customer contact details (name and real phone number)
      let customerName = 'Customer';
      let customerPhone = normalizedSender;
      try {
        const contact = await msg.getContact();
        customerName = contact.pushname || contact.name || 'Customer';
        if (contact.number) {
          customerPhone = contact.number.replace(/[^0-9]/g, '');
        }
        console.log(`[DEBUG] Resolved contact details: name="${customerName}", phone="${customerPhone}", rawNumber="${contact.number || ''}"`);
      } catch (contactErr) {
        console.error(`[DEBUG] Failed to retrieve contact for ${senderId}:`, contactErr.message);
      }

      // Try resolving LID using getContactLidAndPhone if it's a LID format
      if (senderId.includes('@lid') && this.client && typeof this.client.getContactLidAndPhone === 'function') {
        try {
          console.log(`[DEBUG] Attempting getContactLidAndPhone for: ${senderId}`);
          const res = await this.client.getContactLidAndPhone([senderId]);
          console.log(`[DEBUG] getContactLidAndPhone response:`, JSON.stringify(res));
          if (res && res.length > 0 && res[0].pn) {
            customerPhone = res[0].pn.replace(/[^0-9]/g, '');
            console.log(`[DEBUG] Successfully resolved LID ${senderId} to Phone: ${customerPhone}`);
          }
        } catch (lidErr) {
          console.error(`[DEBUG] getContactLidAndPhone error:`, lidErr.message);
        }
      }

      // Check allowed test numbers (Safe Mode filter)
      if (config.wati.allowedTestNumbers && config.wati.allowedTestNumbers.length > 0) {
        const isSenderAllowed = config.wati.allowedTestNumbers.includes(normalizedSender) || 
                              config.wati.allowedTestNumbers.includes(customerPhone);
        if (!isSenderAllowed) {
          console.log(`[DEBUG] Blocked message from ${normalizedSender} (Resolved phone: ${customerPhone}) - not in ALLOWED_TEST_NUMBERS`);
          return;
        }
      }

      console.log(`📬 [WhatsApp] Message from ${customerPhone} (LID: ${normalizedSender}): "${msg.body}"${hasMedia ? ' [+media]' : ''}`);

      // Media handling: forward the customer's photo to the owner (so they can see a
      // damaged/wrong jersey) and give the agent a text stand-in so it responds to the
      // image instead of ignoring an empty body. Best-effort — never blocks the reply.
      let messageBody = msg.body || '';
      if (hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media && (media.mimetype || '').startsWith('image') && config.owner?.whatsappNumber && this.status === 'CONNECTED') {
            const owner = config.owner.whatsappNumber.replace(/[^0-9]/g, '') + '@c.us';
            const fwd = new MessageMedia(media.mimetype, media.data, media.filename || 'customer-photo');
            await this.sendText(owner, fwd, {
              caption: `📷 Photo from customer *${customerName}* (${customerPhone})${msg.body ? `\nCaption: "${msg.body}"` : ''}`
            }).catch(e => console.error('[WhatsApp] Failed to forward media to owner:', e.message));
          }
        } catch (mediaErr) {
          console.error('[WhatsApp] downloadMedia failed:', mediaErr.message);
        }
        if (!messageBody.trim()) {
          messageBody = '[The customer just sent a photo/image of their item.]';
        }
      }

      // Show a "typing..." indicator while the agent works (product search + LLM
      // call(s) can take several seconds) so the customer knows we've seen their
      // message instead of wondering if it went through. WhatsApp auto-expires the
      // typing indicator after ~25s if it isn't refreshed, so keep re-sending it.
      try {
        // Some newer @lid chats reject msg.getChat() in whatsapp-web.js; fall back to
        // resolving the chat by the sender id we already reply to.
        let chat = await msg.getChat().catch(() => null);
        if (!chat) chat = await this.client.getChatById(senderId).catch(() => null);
        if (chat) {
          await chat.sendStateTyping();
          typingInterval = setInterval(() => {
            chat.sendStateTyping().catch(() => {});
          }, 20000);
        }
        // If the chat couldn't be resolved, silently skip the typing indicator — it's
        // purely cosmetic and the reply below still sends normally. (Was logging a noisy
        // "Failed to send typing indicator: r" on every message.)
      } catch {
        /* non-fatal: typing indicator is best-effort */
      }

      // Answer using AI Service
      const agentResponse = await aiService.answerQuery(senderId, messageBody, customerName, customerPhone, { hasMedia });

      console.log(`🧠 [AI Agent] Intent: ${agentResponse.intent.toUpperCase()} | Matches: ${agentResponse.suggestedProductIds.length} products | Escalate: ${agentResponse.requiresEscalation}`);

      // Hold the reply back to a human-plausible turnaround (no-op if the agent already
      // took longer than the target), then send through the paced outbound queue.
      await this.humanizeDelay(receivedAt, agentResponse.replyText);
      await this.sendText(senderId, agentResponse.replyText);
      console.log(`📤 [WhatsApp] Sent reply to ${normalizedSender} (${Date.now() - receivedAt}ms turnaround)`);
    } catch (err) {
      console.error(`❌ [WhatsApp Bot Error]:`, err.message);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  getStatus() {
    // Retry the account read if 'ready' couldn't get it — the admin page polls every 2.5s,
    // so the panel fills in as soon as client.info becomes available instead of showing
    // "Unknown number" for the life of the session.
    if (this.status === 'CONNECTED' && !this.deviceInfo?.number) this.captureDeviceInfo();

    const device = this.status === 'CONNECTED'
      ? (this.deviceInfo || { number: null, name: null, platform: null, connectedAt: this.connectedAt || null })
      : null;

    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      // Only meaningful while CONNECTED; null otherwise so the console can't show a stale
      // number next to a disconnected badge.
      device,
      loggingOut: this.loggingOut,
    };
  }
}

const whatsappWebBot = new WhatsAppWebBot();
export default whatsappWebBot;

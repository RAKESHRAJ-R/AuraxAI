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
      });

      this.client.on('authenticated', () => {
        console.log('[WhatsApp Web Bot] Authenticated successfully.');
      });

      this.client.on('auth_failure', async (msg) => {
        console.error('[WhatsApp Web Bot] Authentication failed:', msg);
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        try {
          await this.client.destroy();
        } catch (err) {
          // ignore
        }
        this.client = null;
      });

      this.client.on('disconnected', async (reason) => {
        console.log('[WhatsApp Web Bot] Client disconnected:', reason);
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        try {
          await this.client.destroy();
        } catch (err) {
          // ignore
        }
        this.client = null;

        // Auto-reinitialize after 10 seconds
        setTimeout(() => {
          this.initialize();
        }, 10000);
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
        // Auto-reinitialize after 10 seconds on failure
        setTimeout(() => {
          this.initialize();
        }, 10000);
      });
    } catch (error) {
      console.error('[WhatsApp Web Bot] Failed to initialize client:', error.message);
      this.status = 'DISCONNECTED';
      this.client = null;
    }
  }

  async handleIncomingMessage(msg) {
    let typingInterval = null;
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
            await this.client.sendMessage(owner, fwd, {
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

      // Reply back
      await this.client.sendMessage(senderId, agentResponse.replyText);
      console.log(`📤 [WhatsApp] Sent reply to ${normalizedSender}`);
    } catch (err) {
      console.error(`❌ [WhatsApp Bot Error]:`, err.message);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  getStatus() {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl
    };
  }
}

const whatsappWebBot = new WhatsAppWebBot();
export default whatsappWebBot;

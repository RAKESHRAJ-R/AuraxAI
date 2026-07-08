import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import config from '../config/config.js';
import aiService from './ai.js';

import async from 'async';

const { Client, LocalAuth } = pkg;

class WhatsAppWebBot {
  constructor() {
    this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
    this.qrDataUrl = null;
    this.client = null;
    this.messageQueue = async.queue(async (msg) => {
      console.log(`[Queue] Processing message... (Waiting in line: ${this.messageQueue.length()})`);
      await this.handleIncomingMessage(msg);
    }, 5);
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
        this.messageQueue.push(msg);
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
    try {
      // Ignore group chats, broadcast/status
      if (msg.isGroupMsg || msg.from.includes('@g.us') || msg.from === 'status@broadcast') {
        return;
      }

      // Check message body exists
      if (!msg.body) return;

      const senderId = msg.from; // e.g. "919940954744@c.us"
      const normalizedSender = senderId.replace(/[^0-9]/g, '');
      console.log(`[DEBUG] Received raw message from: ${senderId} (Normalized: ${normalizedSender})`);

      // Check allowed test numbers (Safe Mode filter)
      if (config.wati.allowedTestNumbers && config.wati.allowedTestNumbers.length > 0) {
        if (!config.wati.allowedTestNumbers.includes(normalizedSender)) {
          return;
        }
      }

      console.log(`📬 [WhatsApp] Message from ${normalizedSender}: "${msg.body}"`);

      // Retrieve customer contact details (name and real phone number)
      let customerName = 'Customer';
      let customerPhone = normalizedSender;
      try {
        const contact = await msg.getContact();
        customerName = contact.pushname || contact.name || 'Customer';
        if (contact.number) customerPhone = contact.number;
      } catch (contactErr) {
        // ignore
      }

      // Answer using AI Service
      const agentResponse = await aiService.answerQuery(senderId, msg.body, customerName, customerPhone);

      console.log(`🧠 [AI Agent] Intent: ${agentResponse.intent.toUpperCase()} | Matches: ${agentResponse.suggestedProductIds.length} products | Escalate: ${agentResponse.requiresEscalation}`);

      // Reply back
      await this.client.sendMessage(senderId, agentResponse.replyText);
      console.log(`📤 [WhatsApp] Sent reply to ${normalizedSender}`);
    } catch (err) {
      console.error(`❌ [WhatsApp Bot Error]:`, err.message);
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

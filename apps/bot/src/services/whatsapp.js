import axios from 'axios';
import config from '../config/config.js';

class WhatsAppService {
  constructor() {
    this.accessToken = config.whatsapp.accessToken || config.instagram.pageAccessToken;
    this.phoneNumberId = config.whatsapp.phoneNumberId;

    this.watiEndpoint = config.wati.endpoint;
    this.watiAccessToken = config.wati.accessToken;

    const isWatiConfigured = this.watiEndpoint && this.watiAccessToken;
    const isMock = !isWatiConfigured && (!this.accessToken || !this.phoneNumberId);

    if (isMock) {
      console.log('[WhatsApp Service] Missing credentials. Running in MOCK Send Mode.');
      this.client = null;
    } else if (isWatiConfigured) {
      console.log('[WhatsApp Service] Running in WATI WhatsApp Send Mode.');
      this.client = null;
    } else {
      this.client = axios.create({
        baseURL: 'https://graph.facebook.com/v25.0',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`
        },
        timeout: 10000,
      });
    }
  }

  /**
   * Send a text message to a WhatsApp recipient phone number (wa_id)
   */
  async sendTextMessage(recipientId, text) {
    if (!recipientId) {
      console.error('[WhatsApp Service] Cannot send message: Recipient ID is missing.');
      return false;
    }

    // 1. WATI Send Mode
    if (this.watiEndpoint && this.watiAccessToken) {
      const cleanRecipient = recipientId.replace(/[^0-9]/g, '').trim();
      console.log(`[WhatsApp Service] Sending WATI text to Mobile: ${cleanRecipient}...`);
      const endpoint = this.watiEndpoint.endsWith('/') ? this.watiEndpoint.slice(0, -1) : this.watiEndpoint;
      const headers = {
        'Authorization': `Bearer ${this.watiAccessToken}`,
        'Content-Type': 'application/json'
      };

      // Try WATI v1 sendSessionMessage API first
      try {
        const url = `${endpoint}/api/v1/sendSessionMessage/${cleanRecipient}`;
        await axios.post(url, {}, {
          params: { messageText: text },
          headers,
          timeout: 10000
        });
        console.log(`[WhatsApp Service] WATI message sent successfully via v1 API.`);
        return true;
      } catch (err) {
        // Fallback to WATI v3 conversations/messages/text API
        try {
          const v3Url = `${endpoint}/api/ext/v3/conversations/messages/text`;
          await axios.post(v3Url, {
            target: cleanRecipient,
            text: text
          }, { headers, timeout: 10000 });
          console.log(`[WhatsApp Service] WATI message sent successfully via v3 API.`);
          return true;
        } catch (v3Err) {
          console.error(`[WhatsApp Service] WATI Send Failed via both v1 and v3 APIs: v1: "${err.message}", v3: "${v3Err.message}"`);
          return false;
        }
      }
    }

    // 2. Meta WhatsApp Cloud API / Mock Send Mode
    if (!this.client) {
      console.log(`\n💬 [MOCK WHATSAPP SEND]`);
      console.log(`   To Mobile: ${recipientId}`);
      console.log(`   Message:   ${text}\n`);
      return true;
    }

    try {
      const cleanRecipient = recipientId.replace(/\+/g, '').trim();
      console.log(`[WhatsApp Service] Sending message to Mobile: ${cleanRecipient}...`);
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanRecipient,
        type: 'text',
        text: {
          preview_url: false,
          body: text
        }
      });

      console.log(`[WhatsApp Service] Message sent successfully. ID: ${response.data.messages?.[0]?.id || 'unknown'}`);
      return true;
    } catch (error) {
      console.error(`[WhatsApp Service] Failed to send message to Mobile: ${recipientId}`);
      if (error.response) {
        console.error(`[WhatsApp Service] Meta WhatsApp API Error: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`[WhatsApp Service] Network/Client Error: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * Send a PDF or Document attachment to a WhatsApp recipient
   */
  async sendDocumentMessage(recipientId, documentUrl, filename, caption = '') {
    if (!recipientId) return false;

    // 1. WATI Send Mode
    if (this.watiEndpoint && this.watiAccessToken) {
      const cleanRecipient = recipientId.replace(/[^0-9]/g, '').trim();
      console.log(`[WhatsApp Service] Sending WATI document to Mobile: ${cleanRecipient}...`);
      const endpoint = this.watiEndpoint.endsWith('/') ? this.watiEndpoint.slice(0, -1) : this.watiEndpoint;
      const headers = {
        'Authorization': `Bearer ${this.watiAccessToken}`,
        'Content-Type': 'application/json'
      };

      // Try WATI v3 fileViaUrl API first
      try {
        const v3Url = `${endpoint}/api/ext/v3/conversations/messages/fileViaUrl`;
        await axios.post(v3Url, {
          target: cleanRecipient,
          file_url: documentUrl,
          caption: caption || filename
        }, { headers, timeout: 10000 });
        console.log(`[WhatsApp Service] WATI document sent successfully via v3 API.`);
        return true;
      } catch (err) {
        // Fallback to WATI v1 sendSessionFile API
        try {
          const v1Url = `${endpoint}/api/v1/sendSessionFile/${cleanRecipient}`;
          await axios.post(v1Url, {}, {
            params: {
              fileUrl: documentUrl,
              fileName: filename
            },
            headers,
            timeout: 10000
          });
          console.log(`[WhatsApp Service] WATI document sent successfully via v1 API.`);
          return true;
        } catch (v1Err) {
          console.error(`[WhatsApp Service] WATI Document Send Failed via both v3 and v1 APIs: v3: "${err.message}", v1: "${v1Err.message}"`);
          return false;
        }
      }
    }

    // 2. Meta WhatsApp Cloud API / Mock Send Mode
    if (!this.client) {
      console.log(`\n📄 [MOCK WHATSAPP DOCUMENT SEND]`);
      console.log(`   To Mobile: ${recipientId}`);
      console.log(`   Doc URL:   ${documentUrl}`);
      console.log(`   Filename:  ${filename}`);
      console.log(`   Caption:   ${caption}\n`);
      return true;
    }

    try {
      const cleanRecipient = recipientId.replace(/\+/g, '').trim();
      console.log(`[WhatsApp Service] Sending document to Mobile: ${cleanRecipient}...`);
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanRecipient,
        type: 'document',
        document: {
          link: documentUrl,
          filename: filename,
          caption: caption
        }
      });
      return true;
    } catch (error) {
      console.error(`[WhatsApp Service] Failed to send document to Mobile: ${recipientId}`, error.message);
      return false;
    }
  }
}

const whatsappService = new WhatsAppService();
export default whatsappService;

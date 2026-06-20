import axios from 'axios';
import config from '../config/config.js';

class WhatsAppService {
  constructor() {
    this.accessToken = config.whatsapp.accessToken || config.instagram.pageAccessToken;
    this.phoneNumberId = config.whatsapp.phoneNumberId;

    const isMock = !this.accessToken || !this.phoneNumberId;

    if (isMock) {
      console.log('[WhatsApp Service] Missing credentials. Running in MOCK Send Mode.');
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

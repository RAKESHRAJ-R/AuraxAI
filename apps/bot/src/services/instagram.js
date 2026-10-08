import axios from 'axios';
import config from '../config/config.js';

class InstagramService {
  constructor() {
    this.accessToken = config.instagram.pageAccessToken || config.whatsapp.accessToken;
    
    if (!this.accessToken) {
      console.log('[Instagram Service] No Page Access Token found. Running in MOCK Send Mode.');
      this.client = null;
    } else {
      this.client = axios.create({
        baseURL: 'https://graph.facebook.com/v25.0',
        headers: {
          'Content-Type': 'application/json',
        },
        params: {
          access_token: this.accessToken,
        },
        timeout: 10000,
      });
    }
  }

  /**
   * Send a text message to an Instagram User Scope ID (IGSID)
   */
  async sendTextMessage(recipientId, text) {
    if (!recipientId) {
      console.error('[Instagram Service] Cannot send message: Recipient ID is missing.');
      return false;
    }

    if (!this.client) {
      console.log(`\n📸 [MOCK INSTAGRAM SEND]`);
      console.log(`   To IGSID:  ${recipientId}`);
      console.log(`   Message:   ${text}\n`);
      return true;
    }

    try {
      console.log(`[Instagram Service] Sending message to IGSID: ${recipientId}...`);
      const response = await this.client.post('/me/messages', {
        recipient: {
          id: recipientId,
        },
        message: {
          text: text,
        },
      });

      console.log(`[Instagram Service] Message sent successfully. Mid: ${response.data.message_id || 'unknown'}`);
      return true;
    } catch (error) {
      console.error(`[Instagram Service] Failed to send message to IGSID: ${recipientId}`);
      if (error.response) {
        console.error(`[Instagram Service] Meta API Error: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`[Instagram Service] Network/Client Error: ${error.message}`);
      }
      return false;
    }
  }
}

const instagramService = new InstagramService();
export default instagramService;

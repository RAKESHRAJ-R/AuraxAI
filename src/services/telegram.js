import axios from 'axios';
import config from '../config/config.js';

class TelegramService {
  constructor() {
    this.botToken = config.telegram.botToken;
    this.chatId = config.telegram.chatId;
  }

  /**
   * Send alert notification to the configured Telegram chat/group
   * @param {string} text - Message text (supports HTML tags)
   */
  async sendAlert(text) {
    if (!this.botToken || !this.chatId) {
      console.log('\n📣 [MOCK TELEGRAM SEND]');
      console.log(`   Message:   ${text}\n`);
      return true;
    }

    try {
      console.log(`[Telegram Service] Sending alert to Chat ID: ${this.chatId}...`);
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text: text,
        parse_mode: 'HTML'
      });
      console.log('[Telegram Service] Alert sent successfully.');
      return true;
    } catch (error) {
      console.error('[Telegram Service] Failed to send alert:');
      if (error.response) {
        console.error(`   Telegram API Error: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`   Network Error: ${error.message}`);
      }
      return false;
    }
  }
}

const telegramService = new TelegramService();
export default telegramService;

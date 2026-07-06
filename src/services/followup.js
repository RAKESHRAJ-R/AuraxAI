import dbService from './db.js';
import whatsappWebBot from './whatsapp-web-bot.js';

const INACTIVE_HOURS = 3;
const MAX_FOLLOW_UPS = 2;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

class FollowUpService {
  start() {
    setInterval(() => this.runFollowUpCheck(), CHECK_INTERVAL_MS);
    console.log('[FollowUp] Cold lead follow-up scheduler started (every 30 min).');
  }

  async runFollowUpCheck() {
    if (!whatsappWebBot.client || whatsappWebBot.status !== 'CONNECTED') {
      console.log('[FollowUp] WhatsApp not connected, skipping check.');
      return;
    }

    const leads = await dbService.getActiveLeads();
    const now = Date.now();
    let contacted = 0;

    for (const lead of leads) {
      if (!lead.userId || !lead.userId.includes('@c.us')) continue;

      const lastUpdate = new Date(lead.updatedAt).getTime();
      const hoursInactive = (now - lastUpdate) / (1000 * 60 * 60);
      const followUpCount = lead.followUpCount || 0;

      if (hoursInactive >= INACTIVE_HOURS && followUpCount < MAX_FOLLOW_UPS) {
        await this.sendFollowUp(lead);
        contacted++;
        // Stagger messages to avoid WhatsApp spam detection
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (contacted > 0) {
      console.log(`[FollowUp] Sent follow-ups to ${contacted} inactive lead(s).`);
    }
  }

  async sendFollowUp(lead) {
    const firstName = (lead.name || 'Customer').split(' ')[0];
    const hasCartItems = lead.cart && lead.cart.length > 0;
    const followUpCount = lead.followUpCount || 0;

    let message;
    if (hasCartItems) {
      const item = lead.cart[0];
      if (followUpCount === 0) {
        message = `Hey ${firstName}! 👋 You were checking out the *${item.name}* earlier.\n\nStill interested? Just reply and I'll pick up right where we left off! 🔥`;
      } else {
        message = `${firstName}, this is your last reminder! 😊 The *${item.name}* is still waiting in your cart.\n\nReply YES to complete your order, or let me know if you need help! ⚽`;
      }
    } else {
      if (followUpCount === 0) {
        message = `Hey ${firstName}! 👋 Still looking for jerseys? Drop your favorite team name and I'll find the best one for you! 🏆`;
      } else {
        message = `${firstName}, we have some amazing new arrivals! 🔥 What team are you supporting this season? ⚽`;
      }
    }

    try {
      await whatsappWebBot.client.sendMessage(lead.userId, message);
      await dbService.updateLeadFollowUp(lead.userId);
      console.log(`[FollowUp] Follow-up #${followUpCount + 1} sent to ${lead.phone || lead.userId}`);
    } catch (err) {
      console.error(`[FollowUp] Failed to reach ${lead.phone || lead.userId}:`, err.message);
    }
  }
}

const followUpService = new FollowUpService();
export default followUpService;

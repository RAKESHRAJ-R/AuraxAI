import config from '../config/config.js';
import dbService from './db.js';
import whatsappWebBot from './whatsapp-web-bot.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

class FollowUpService {
  start() {
    if (!config.followUp.enabled) {
      console.log('[FollowUp] Disabled by config — cold leads will NOT be re-engaged.');
      return;
    }
    setInterval(() => this.runFollowUpCheck(), CHECK_INTERVAL_MS);
    console.log(
      `[FollowUp] Cold lead follow-up scheduler started (every 30 min, ` +
      `max ${config.followUp.maxPerRun} per run).`
    );
  }

  async runFollowUpCheck() {
    if (!config.followUp.enabled) return;
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

      if (hoursInactive >= config.followUp.inactiveHours && followUpCount < config.followUp.maxPerLead) {
        // Unsolicited messages are the first thing to give way when the account has already
        // contacted a lot of people this hour — a cold lead can always be nudged next run.
        const budget = whatsappWebBot.chatBudget?.();
        if (budget && !budget.hasRoom) {
          console.log(`[FollowUp] Account already messaged ${budget.used}/${budget.max} chats this hour — holding off.`);
          break;
        }
        await this.sendFollowUp(lead);
        contacted++;
        // Stop well short of walking the whole lead list in one pass. A run that contacts
        // every cold lead it can find is a broadcast no matter how it is spaced; the
        // remainder are simply picked up by the next run 30 minutes later.
        if (contacted >= config.followUp.maxPerRun) {
          console.log(`[FollowUp] Per-run cap (${config.followUp.maxPerRun}) reached — the rest wait for the next run.`);
          break;
        }
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
      // Route through the paced outbound queue, not client.sendMessage directly. This is
      // the highest ban-risk path in the app: it fires unsolicited, near-identical
      // messages at a batch of cold leads in a tight loop — the textbook automation
      // pattern. sendText() spaces them out globally.
      await whatsappWebBot.sendText(lead.userId, message);
      await dbService.updateLeadFollowUp(lead.userId);
      console.log(`[FollowUp] Follow-up #${followUpCount + 1} sent to ${lead.phone || lead.userId}`);
    } catch (err) {
      console.error(`[FollowUp] Failed to reach ${lead.phone || lead.userId}:`, err.message);
    }
  }
}

const followUpService = new FollowUpService();
export default followUpService;

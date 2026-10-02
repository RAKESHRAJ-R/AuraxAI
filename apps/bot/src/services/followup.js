import config from '../config/config.js';
import dbService from './db.js';
import whatsappWebBot from './whatsapp-web-bot.js';
import woocommerceService from './woocommerce.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
// Payment reminders run far more often: an unpaid order is cancelled 60 minutes after it is
// placed, so a 30-minute tick could land the reminder after the link is already dead.
const PAYMENT_CHECK_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// WooCommerce statuses that mean the customer has paid (or the team has taken it over).
const PAID_STATUSES = new Set(['processing', 'completed', 'on-hold', 'shipped', 'delivered']);
const DEAD_STATUSES = new Set(['cancelled', 'failed', 'expired']);

// A customer chat. Leads are keyed by WhatsApp's sender id, and on a LID-based account that
// is `…@lid`, not `…@c.us` — the old `@c.us`-only check skipped every such customer with no
// log line, so nobody on a LID account was ever followed up (found 2026-10-01).
const isCustomerChat = (id) => typeof id === 'string' && /^\d+@(c\.us|lid)$/.test(id);

class FollowUpService {
  start() {
    if (!config.followUp.enabled) {
      console.log('[FollowUp] Disabled by config — cold leads will NOT be re-engaged.');
      return;
    }
    setInterval(() => this.runFollowUpCheck(), CHECK_INTERVAL_MS);
    setInterval(() => this.runPaymentReminders().catch(err =>
      console.error('[FollowUp] Payment reminder run failed:', err.message)), PAYMENT_CHECK_MS);
    console.log(
      `[FollowUp] Cold lead follow-up scheduler started (every 30 min, ` +
      `max ${config.followUp.maxPerRun} per run, ${config.followUp.maxPerLead} per lead, ` +
      `${config.followUp.cooldownHours}h apart, nothing older than ${config.followUp.maxLeadAgeDays}d, ` +
      `quiet ${config.followUp.quietStartHour}:00–${config.followUp.quietEndHour}:00 IST; ` +
      `unpaid-order reminder after ${config.followUp.paymentReminderMinutes} min, checked every 5 min).`
    );
  }

  /** Overridable clock — the test suite moves it. */
  now() { return Date.now(); }

  /** True inside the configured no-nudge hours (IST). Same start and end = never quiet. */
  inQuietHours(at = this.now()) {
    const start = config.followUp.quietStartHour;
    const end = config.followUp.quietEndHour;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' })
      .format(new Date(at)));
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  async runFollowUpCheck() {
    if (!config.followUp.enabled) return;
    if (!whatsappWebBot.client || whatsappWebBot.status !== 'CONNECTED') {
      console.log('[FollowUp] WhatsApp not connected, skipping check.');
      return;
    }
    // An unprompted nudge at 1 AM is the kind of message that gets a number reported.
    // Nothing is lost: the lead is still overdue at the first morning run.
    if (this.inQuietHours()) return;

    const leads = await dbService.getActiveLeads();
    const now = this.now();
    let contacted = 0;
    let skippedCooldown = 0;
    let skippedStale = 0;
    let skippedContext = 0;

    for (const lead of leads) {
      if (!isCustomerChat(lead.userId)) continue;

      const lastUpdate = new Date(lead.updatedAt).getTime();
      if (!Number.isFinite(lastUpdate)) continue;
      const hoursInactive = (now - lastUpdate) / (1000 * 60 * 60);
      const lastFollowUpAt = lead.lastFollowUp ? new Date(lead.lastFollowUp).getTime() : 0;
      // The customer wrote back after our last nudge: that was a new conversation, so the
      // count starts again. maxPerLead means "per silence", not "per lifetime" — a lifetime
      // cap meant anyone nudged twice, ever, was never followed up again (2026-10-01).
      const repliedSince = Number.isFinite(lastFollowUpAt) && lastFollowUpAt > 0 && lastUpdate > lastFollowUpAt;
      const followUpCount = repliedSince ? 0 : (lead.followUpCount || 0);

      // Too old to nudge. A lead that went quiet days ago is a cold contact, not an
      // in-progress conversation, and messaging it is "starting a new chat".
      if (config.followUp.maxLeadAgeDays > 0 &&
          hoursInactive > config.followUp.maxLeadAgeDays * 24) {
        skippedStale++;
        continue;
      }

      // Space the nudges out from OUR last one, not from the customer's last message.
      // See config.followUp.cooldownHours — this is the guard that stops follow-up #2
      // firing 30 minutes after #1. It holds even if they replied in between: a reply
      // restarts the COUNT, never the minimum gap between two unprompted messages.
      if (lastFollowUpAt && Number.isFinite(lastFollowUpAt) &&
          (now - lastFollowUpAt) < config.followUp.cooldownHours * HOUR_MS) {
        skippedCooldown++;
        continue;
      }

      if (hoursInactive >= config.followUp.inactiveHours && followUpCount < config.followUp.maxPerLead) {
        // Unsolicited messages are the first thing to give way when the account has already
        // contacted a lot of people this hour — a cold lead can always be nudged next run.
        const budget = whatsappWebBot.chatBudget?.();
        if (budget && !budget.hasRoom) {
          console.log(`[FollowUp] Account already messaged ${budget.used}/${budget.max} chats this hour — holding off.`);
          break;
        }
        // What the conversation was actually about decides whether a cold nudge fits at all.
        let session = null;
        try { session = await dbService.getSession(lead.userId); } catch { /* treat as unknown */ }
        if (this.coldNudgeBlocker(session, lastUpdate, now)) { skippedContext++; continue; }
        await this.sendFollowUp({ ...lead, followUpCount }, session, { restart: repliedSince });
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

    if (contacted > 0 || skippedCooldown > 0 || skippedStale > 0 || skippedContext > 0) {
      console.log(
        `[FollowUp] Sent ${contacted} follow-up(s); skipped ${skippedCooldown} in cooldown, ` +
        `${skippedStale} too old (>${config.followUp.maxLeadAgeDays}d), ` +
        `${skippedContext} not suitable (ordered / said no / with the team).`
      );
    }
  }

  /**
   * Why a "still looking for jerseys?" nudge would be wrong for this conversation, or null.
   *   - they ordered recently: the payment reminder speaks to them, not a sales nudge
   *   - their last word was "no need" / "okay, bye": they closed the chat themselves
   *   - the chat was handed to a person
   */
  coldNudgeBlocker(session, lastUpdate, now = this.now()) {
    if (!session) return null;
    const lo = session.lastOrder;
    // The payment reminder / expired-order note already spoke after their last message.
    const orderNoteAt = Math.max(lo?.paymentReminderAt || 0, lo?.expiredNoticeAt || 0);
    if (orderNoteAt && orderNoteAt >= lastUpdate) return 'order_note_sent';
    if (lo?.orderId && now - (lo.at || 0) < Math.max(1, config.followUp.maxLeadAgeDays) * 24 * HOUR_MS) {
      // Order #77999 (10/1 8:31 AM, never paid) blocked every nudge for three days — though the
      // customer came back at 8:39 to buy ANOTHER jersey and went quiet at 8:48 mid-purchase.
      // A new purchase after the order is not "they already ordered".
      const after = (lo.at || 0) + 2 * 60 * 1000;
      const shoppingAgain = lastUpdate > after && Boolean(
        session.cart?.length || session.selectedProduct || session.lastShownProducts?.length
        || (session.removedCart?.at || 0) > after);
      if (!shoppingAgain) return 'recent_order';
    }
    if (session.closedAt && session.closedAt >= lastUpdate - 2 * 60 * 1000) return 'customer_closed';
    if (session.handoffAt && now - session.handoffAt < 24 * HOUR_MS) return 'with_team';
    return null;
  }

  /*
   * ── Unpaid-order reminder (added 2026-10-01) ─────────────────────────────────────────
   * A customer placed order #77997 at 10:52 PM, did not pay, and heard nothing: the lead was
   * marked 'completed' the moment the order was created, so no follow-up ever looked at it,
   * and WooCommerce quietly cancelled it an hour later — a sale lost with the customer still
   * willing.
   *
   * Every 5 minutes, for orders placed in the last 24h (read from each session's lastOrder):
   *   pending, ≥ paymentReminderMinutes old, before the hold runs out → ONE reminder with the link
   *   cancelled/failed (never paid)  → ONE note, with the same cart + address put back so a
   *                                    one-word "YES" places it again (waits out quiet hours)
   *   paid / taken over by the team  → recorded, nothing sent
   * The status comes from WooCommerce every time — never assumed from the clock. The session
   * is stamped BEFORE the message is sent, so a crash or a second process can at worst miss
   * a reminder, never send two.
   */
  async runPaymentReminders() {
    if (!config.followUp.enabled) return;
    if (!whatsappWebBot.client || whatsappWebBot.status !== 'CONNECTED') return;
    const now = this.now();
    const holdMs = (config.payment?.holdMinutes || 60) * 60 * 1000;
    const remindAfterMs = (config.followUp.paymentReminderMinutes || 25) * 60 * 1000;

    const sessions = await dbService.getAllSessions();
    for (const s of sessions) {
      const userId = s.userId;
      const lo = s.lastOrder;
      if (!isCustomerChat(userId) || !lo?.orderId || !lo.checkoutUrl) continue;
      const age = now - (lo.at || 0);
      // From a few minutes in, so a customer who pays straight away is thanked soon after —
      // not only once the reminder would have been due.
      if (age < 3 * 60 * 1000 || age > 24 * HOUR_MS) continue;
      if (lo.paidSeenAt || lo.expiredNoticeAt) continue;
      // Mid-conversation right now: don't talk over them, try again next tick.
      const lastActive = s.lastActive ? new Date(s.lastActive).getTime() : 0;
      if (now - lastActive < 3 * 60 * 1000) continue;

      const res = await woocommerceService.getOrder(lo.orderId);
      if (!res?.success) continue; // unknown — never guess, try next tick
      let status = String(res.order?.status || '').toLowerCase();

      // The hold ran out and it is still unpaid. WooCommerce will never cancel it (bot orders
      // are 'rest-api'), so without this the customer heard nothing after the reminder and the
      // order sat pending forever (#78000, 2026-10-02). Cancel it, then the note below goes out.
      if (status === 'pending' && age >= holdMs && config.payment?.autoCancel) {
        const c = await woocommerceService.cancelUnpaidOrder(lo.orderId,
          `Not paid within ${Math.round(holdMs / 60000)} minutes — cancelled automatically by the WhatsApp bot.`);
        if (c?.success) status = 'cancelled';
        else if (c?.status) status = String(c.status).toLowerCase(); // paid in the meantime
        else continue; // could not reach the store — try next tick
      }

      if (PAID_STATUSES.has(status)) {
        // Paid → one thank-you. Right after paying it is the reply they expect, so it goes
        // out even at night; a payment we only notice hours later waits for the morning.
        if (age > 2 * HOUR_MS && this.inQuietHours(now)) continue;
        const session = await this._markOrder(userId, lo.orderId, { paidSeenAt: now, thanksSentAt: now });
        if (!session) continue;
        await this._send(userId, session, this.paidThanksText(session, lo), 'thank-you');
        continue;
      }
      if (status === 'pending' && !lo.paymentReminderAt && age >= remindAfterMs && age < holdMs) {
        const minsLeft = Math.max(1, Math.ceil((holdMs - age) / 60000));
        const session = await this._markOrder(userId, lo.orderId, { paymentReminderAt: now });
        if (!session) continue;
        await this._send(userId, session, this.paymentReminderText(session, lo, minsLeft), 'payment reminder');
        continue;
      }
      if (DEAD_STATUSES.has(status) && !lo.expiredNoticeAt) {
        // A note about a dead order is not urgent; it waits for the morning like a nudge.
        if (this.inQuietHours(now)) continue;
        const session = await this._markOrder(userId, lo.orderId, { expiredNoticeAt: now }, { restoreCart: true });
        if (!session) continue;
        await this._send(userId, session, this.expiredOrderText(session, lo), 'expired-order note');
      }
    }
  }

  /**
   * Re-read the session, stamp the order, save. Returns the saved session, or null when the
   * session moved on (a newer order, or the customer wrote in between and the save conflicted).
   * With restoreCart, the expired order's items + address go back into the cart at the
   * confirm step, so the customer's "YES" re-places it through the normal order path.
   */
  async _markOrder(userId, orderId, fields, { restoreCart = false } = {}) {
    const session = await dbService.getSession(userId);
    if (!session?.lastOrder || String(session.lastOrder.orderId) !== String(orderId)) return null;
    Object.assign(session.lastOrder, fields);
    if (restoreCart && Array.isArray(session.lastOrder.items) && session.lastOrder.items.length > 0
        && !(session.cart?.length) && !session.selectedProduct) {
      const items = session.lastOrder.items.map(i => ({ ...i }));
      const first = items[0];
      session.cart = items;
      session.selectedProduct = { productId: first.productId, name: first.name, price: first.price, sizes: [], permalink: '' };
      const addr = session.addressDetails || session.customerProfile || null;
      if (addr?.name && addr?.address && addr?.pincode && addr?.phone) {
        session.addressDetails = { ...addr };
        session.address = `${addr.name}, ${addr.address}, ${addr.pincode} | Ph: ${addr.phone}`;
        session.state = 'CONFIRMING_ORDER';
      } else {
        session.state = 'COLLECTING_ADDRESS';
      }
      session.reorderOffered = true;
    }
    const saved = await dbService.saveSession(userId, session);
    if (saved === false || saved === 'conflict') return null;
    return session;
  }

  async _send(userId, session, text, label) {
    try {
      await whatsappWebBot.sendText(userId, text);
      // Into the chat history, so the bot's next turn knows what it just said
      // ("pay panniten" after the reminder is about this order).
      try {
        const fresh = await dbService.getSession(userId);
        fresh.history = [...(fresh.history || []), { role: 'assistant', content: text }].slice(-10);
        await dbService.saveSession(userId, fresh);
      } catch { /* the message went out; history is a nicety */ }
      console.log(`[FollowUp] Sent ${label} to ${session.customerPhone || userId} (order #${session.lastOrder?.orderId}).`);
    } catch (err) {
      console.error(`[FollowUp] Failed to send ${label} to ${userId}:`, err.message);
    }
  }

  _firstName(session) {
    const n = session?.customerName;
    return n && n !== 'Customer' ? ` ${String(n).split(' ')[0]}` : '';
  }

  paymentReminderText(session, lo, minsLeft) {
    const isT = session.language === 'tanglish';
    const first = this._firstName(session);
    const it = lo.items?.[0];
    const what = it ? (isT ? ` (*${it.name}* — ${it.size} size, ${it.qty} qty)` : ` (*${it.name}* — Size ${it.size}, Qty ${it.qty})`) : '';
    return isT
      ? `Hi${first} 👋 Unga order #${lo.orderId}${what} ku payment innum pending la iruku.\n⏳ ${minsLeft} nimishathukkulla pay pannalana, order auto-cancel aagidum.\nPay panna: ${lo.checkoutUrl}\nPay panradhula edhavadhu problem na inga sollunga 🙏`
      : `Hi${first} 👋 Payment for your order #${lo.orderId}${what} is still pending.\n⏳ If it isn't paid in the next ${minsLeft} minutes, the order is cancelled automatically.\nPay here: ${lo.checkoutUrl}\nAny trouble paying? Just tell me here 🙏`;
  }

  expiredOrderText(session, lo) {
    const isT = session.language === 'tanglish';
    const first = this._firstName(session);
    const ready = session.reorderOffered && session.state === 'CONFIRMING_ORDER';
    // Not "innum venumna" — the owner read it as meaningless (2026-10-01). Say what "it" is.
    if (isT) {
      return `Hi${first} 👋 Unga order #${lo.orderId} ku payment varala, adhanala order auto-cancel aayiduchu 😕\n`
        + (ready ? 'Indha jersey ippavum vaanganum na, "YES" nu reply pannunga — same jersey, same address la pudhu order potturen 👍'
                 : 'Indha jersey ippavum vaanganum na, inga oru message pannunga — pudhu order potturen 👍');
    }
    return `Hi${first} 👋 Order #${lo.orderId} wasn't paid, so it was cancelled automatically 😕\n`
      + (ready ? `Still want it? Reply "YES" and I'll place it again — same jersey, same address 👍`
               : `Still want it? Just message me here and I'll place a fresh order 👍`);
  }

  paidThanksText(session, lo) {
    const isT = session.language === 'tanglish';
    const first = this._firstName(session);
    return isT
      ? `Hi${first} 👋 Payment vandhuduchu ✅ Unga order #${lo.orderId} confirm aayiduchu.\nTheaurax la vaanginadhukku romba thanks! 🎉 Unga order ah ready panni seekiram dispatch panrom 📦\nEdhavadhu doubt irundha inga message pannunga 🙏`
      : `Hi${first} 👋 Payment received ✅ Your order #${lo.orderId} is confirmed.\nThank you for shopping with Theaurax! 🎉 Your jersey will be on its way soon.\nAny questions, just message me here 🙏`;
  }

  async sendFollowUp(lead, session = null, { restart = false } = {}) {
    const firstName = (lead.name || 'Customer').split(' ')[0];
    // The session is the live cart; the lead's copy is only as fresh as its last save.
    if (!(lead.cart?.length) && session?.cart?.length) lead = { ...lead, cart: session.cart };
    const hasCartItems = lead.cart && lead.cart.length > 0;
    const followUpCount = lead.followUpCount || 0;

    // Follow-ups were English-only regardless of who they went to, so a customer who had
    // held their entire conversation in Tanglish got an unprompted English message hours
    // later — the same mismatch the bilingual FAQ work fixed on 2026-08-04, just on the one
    // path that speaks first. The session is the authority on language (it is locked there
    // for the whole conversation); a lead we cannot read a session for gets English, which
    // is what it would have got anyway.
    let language = 'english';
    try {
      const s = session || await dbService.getSession(lead.userId);
      if (s?.language === 'tanglish') language = 'tanglish';
    } catch { /* keep English */ }
    const isTanglish = language === 'tanglish';

    let message;
    if (hasCartItems) {
      const item = lead.cart[0];
      if (followUpCount === 0) {
        message = isTanglish
          ? `Hey ${firstName}! 👋 Neenga *${item.name}* paathinga illa?\n\nInnum venuma? Reply pannunga, naan continue panren! 🔥`
          : `Hey ${firstName}! 👋 You were checking out the *${item.name}* earlier.\n\nStill interested? Just reply and I'll pick up right where we left off! 🔥`;
      } else {
        message = isTanglish
          ? `${firstName}, last reminder bro! 😊 *${item.name}* unga cart la wait panidu iruku.\n\nOrder mudikka "yes" nu reply pannunga, illa help venumna sollunga! ⚽`
          : `${firstName}, this is your last reminder! 😊 The *${item.name}* is still waiting in your cart.\n\nReply YES to complete your order, or let me know if you need help! ⚽`;
      }
    } else {
      if (followUpCount === 0) {
        message = isTanglish
          ? `Hey ${firstName}! 👋 Jersey thedringala? Unga favourite team peru sollunga, naan best options kaatturen! 🏆`
          : `Hey ${firstName}! 👋 Still looking for jerseys? Drop your favorite team name and I'll find the best one for you! 🏆`;
      } else {
        message = isTanglish
          ? `${firstName}, pudhusa nalla collection vanthiruku! 🔥 Indha season enna team support panringa? ⚽`
          : `${firstName}, we have some amazing new arrivals! 🔥 What team are you supporting this season? ⚽`;
      }
    }

    try {
      // Route through the paced outbound queue, not client.sendMessage directly. This is
      // the highest ban-risk path in the app: it fires unsolicited, near-identical
      // messages at a batch of cold leads in a tight loop — the textbook automation
      // pattern. sendText() spaces them out globally.
      await whatsappWebBot.sendText(lead.userId, message);
      await dbService.updateLeadFollowUp(lead.userId, { restart });
      console.log(`[FollowUp] Follow-up #${followUpCount + 1} sent to ${lead.phone || lead.userId}`);
    } catch (err) {
      console.error(`[FollowUp] Failed to reach ${lead.phone || lead.userId}:`, err.message);
    }
  }
}

const followUpService = new FollowUpService();
export default followUpService;

/**
 * Understand the customer's message BEFORE anything answers it (added 2026-09-30).
 *
 * Why this exists. Until now every message ran down a chain of keyword checks — reset words,
 * address words, "already sent" words, FAQ keywords, "which teams" words — and the first one
 * that matched answered. The AI only saw what nothing else caught. The 2026-09-29 chat shows
 * where that leads:
 *
 *   "I want Man City jersey"         → saved as the shipping ADDRESS (free text = address)
 *   "Already order place panniten"   → "you already sent your address" ("panniten")
 *   "Evolo naal agum bro"            → team list (FAQ knows "evlo naal", not "evolo naal agum")
 *   "Okay" / "No need" (fed up)      → the same 12-line team list, four times
 *
 * A keyword is not a meaning. Tanglish has no fixed spelling, and "okay" after four wrong
 * answers means "I'm done", not "okay". So the order is now:
 *
 *   message → understand() reads it with the whole chat and the order state
 *           → code ACTS on that meaning (cart, price, link, delivery days, product lists)
 *           → the egress checks run on the way out
 *           → the old keyword chain runs ONLY when understand() returns null
 *             (every provider down, a malformed answer, or switched off)
 *
 * The model is asked for a small fixed-shape JSON verdict and nothing else. It never writes
 * the customer's reply here, so it cannot invent a price or a Tamil word in this step.
 */

const INTENTS = [
  'greeting',            // hi / vanakkam, nothing else
  'product_search',      // names or describes something to buy: a team, player, season, style
  'browse_catalogue',    // "what do you sell?", "I don't know what to buy"
  'list_teams',          // "which teams / countries do you have?"
  'list_more',           // "show me all of them", "vera options?", "full list"
  'pick_product',        // choosing from the list on screen ("2", "the Kroos one")
  'size_qty',            // giving or changing size and/or quantity
  'give_address',        // sending name / address / pincode / phone
  'change_address',      // "address maathanum", "intha address venaam" — keep the jersey, new address
  'confirm_order',       // saying yes to the order summary on screen
  'pause_order',         // "not now", "later", "I'll think about it" — keep the cart
  'cancel_cart',         // "remove it", "cancel the cart", "I don't want this" — before ordering
  'restore_cart',        // "don't remove it", "that jersey is fine", "undo" — after the shop removed it
  'start_over',          // "start over", "forget my data", "reset"
  'delivery_question',   // when will it arrive, how many days
  'payment_question',    // how to pay, COD, payment link
  'policy_question',     // sizing, customisation, returns, quality, versions, shipping charge…
  'product_question',    // a question about a product already shown (price, sleeve, shorts…)
  'order_status',        // about an order ALREADY PLACED: status, "already ordered", payment pending
  'cancel_placed_order', // cancel an order that was already placed
  'complaint',           // something went wrong with an order they received
  'human_request',       // wants a person
  'not_understood',      // cannot understand the SHOP's reply ("purila", "what are you saying")
  'closing',             // ending the chat: "okay", "no need", "thanks", "bye" — nothing to do
  'other',
];

const TOPICS = [
  'delivery', 'payment', 'cod', 'sizing', 'customisation', 'returns', 'quality', 'versions',
  'shipping_charge', 'international', 'care', 'bulk', 'tracking', 'kids', 'fc_set', 'giveaway',
  'contact', 'none',
];

const MOODS = ['fine', 'confused', 'frustrated', 'angry'];

const CATEGORIES = ['club', 'country', 'cricket', 'kids', 'gear', 'none'];

// The static part — byte-identical on every call so providers cache it.
const SYSTEM = `You read ONE WhatsApp message sent to a football-jersey shop (Theaurax.in, India) and work out what the customer MEANS. Customers write English or Tanglish (romanised Tamil mixed with English) with any spelling: "epo / yepo / eppo" = when, "evlo / evolo / ethana" = how many/much, "naal" = days, "agum / aagum" = will take, "varum / varadhuku" = will come / to arrive, "venum" = want, "vendaam / venam" = don't want, "iruka / iruku" = is there, "panniten / pannitten" = I did, "podhum" = enough, "seri / sari" = ok.

Read the message together with the recent chat and the order state. Decide from MEANING, never from a single word:
- "Okay", "no need", "podhum", "thanks", "vidunga" after the shop answered or after the customer already declined = closing (nothing to do). "Okay"/"yes" right after an order summary asking to confirm = confirm_order.
- If the shop kept repeating itself or ignored the question, the customer is frustrated.
- "I want Man City jersey" is product_search even while the shop is waiting for an address. An address has real address parts (door no, street, area, city, pincode, phone).
- "Already order place panniten" / "payment pending" after an order was placed = order_status.
- "Delivery?" / "evolo naal agum" = delivery_question — and if an order was just placed it is about THAT order.
- "cancel it from my cart" / "I don't want it" before ordering = cancel_cart — ONLY when they mean the jersey/order. "not now" / "later" = pause_order.
- "address change pannanum / address maathanum / intha address venaam / vera address kudukuren / address thappu / wrong address" = change_address: keep the jersey, they want to give a NEW address. "Address change panniten" means the same (they want it changed). If the message itself already carries the new address (street, pincode, phone), it is give_address.
- "Ithu venaam" / "this one no" right after the customer talked about the ADDRESS means the address = change_address, not cancel_cart.
- After the shop removed a jersey: "remove pannadheenga / don't remove / andha jersey okay dhaan / keep it / undo" = restore_cart (even if they also want to change the address).
- Insults ("loosu", "waste", "mental") or repeating the same request because the shop got it wrong = mood angry or frustrated. Still pick the intent of what they are asking for.
- "which countries / world cup options?" = list_teams or product_search with category. "list all / vera options / ellam kaatunga" = list_more.
- "purila / puriyala / what are you saying" about the shop's last reply = not_understood (NOT a complaint — nothing went wrong with an order).
- A message can hold several questions; list each one in plain English.

Answer with ONLY a JSON object, no prose, no code fence:
{"intent":"<one of: ${INTENTS.join('|')}>",
 "topic":"<one of: ${TOPICS.join('|')}>",
 "mood":"<one of: ${MOODS.join('|')}>",
 "questions":["each question the customer asked, in plain English"],
 "search":"<team/player/season/style words to search for, in English, or empty>",
 "category":"<one of: ${CATEGORIES.join('|')}>",
 "pick":<number from the list on screen, or null>,
 "size":"<S|M|L|XL|XXL|XXXL or empty>",
 "qty":<number or null>,
 "about_placed_order":<true if about an order that is already placed>,
 "meaning":"<one short English sentence: what the customer means>",
 "confidence":<0 to 1>}`;

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** The dynamic part: order state + the last few turns. Code-maintained, so it is the truth. */
function stateSummary(session, orderState) {
  const lines = [];
  const step = orderState.computeStep(session);
  lines.push(`Order step: ${step}`);
  const item = session.cart?.[0];
  const locked = orderState.lockedProduct(session);
  if (item) lines.push(`Cart: ${item.name} — size ${item.size}, qty ${item.qty}`);
  else if (locked) lines.push(`Product chosen (no size/qty yet): ${locked.name}`);
  else lines.push('Cart: empty');
  if (session.state === 'CONFIRMING_ORDER') lines.push('The shop has shown the order summary and asked the customer to reply YES to confirm.');
  const shown = session.lastShownProducts || [];
  if (shown.length > 0) {
    lines.push(`Products on screen (numbered): ${shown.slice(0, 10).map((p, i) => `${i + 1}. ${clip(p.name, 70)}`).join(' | ')}`);
  }
  if (session.pendingBrowse && Array.isArray(session.browseGroups)) {
    lines.push(`Category menu on screen: ${session.browseGroups.map((g, i) => `${i + 1}. ${g.label}`).join(' | ')}`);
  }
  const rc = session.removedCart;
  if (rc?.cart?.[0] && Date.now() - (rc.at || 0) < 60 * 60 * 1000) {
    lines.push(`The shop REMOVED ${clip(rc.cart[0].name, 70)} (size ${rc.cart[0].size}, qty ${rc.cart[0].qty}) from the cart ${Math.round((Date.now() - rc.at) / 60000)} min ago.`);
  }
  if (session.addressDetails?.address) lines.push(`Shipping address on file: ${clip(session.addressDetails.address, 80)}`);
  const lo = session.lastOrder;
  if (lo?.orderId) {
    const mins = Math.round((Date.now() - (lo.at || 0)) / 60000);
    lines.push(`An order was ALREADY PLACED: #${lo.orderId}, ${mins} min ago, payment ${lo.checkoutUrl ? 'link sent, payment pending' : 'link pending'}.`);
  }
  return lines.join('\n');
}

function recentChat(session, turns = 8) {
  const h = (session.history || []).filter(m => m.role === 'user' || m.role === 'assistant').slice(-turns);
  if (h.length === 0) return '(no earlier messages)';
  return h.map(m => `${m.role === 'user' ? 'Customer' : 'Shop'}: ${clip(m.content, 280)}`).join('\n');
}

function buildMessages(session, message, orderState) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `ORDER STATE:\n${stateSummary(session, orderState)}\n\nRECENT CHAT:\n${recentChat(session)}\n\nNEW MESSAGE FROM THE CUSTOMER:\n${clip(message, 600)}`,
    },
  ];
}

/** Pull the first {...} object out of a model reply and validate it. Null when unusable. */
function parseVerdict(text) {
  if (!text) return null;
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object' || !INTENTS.includes(raw.intent)) return null;

  const size = String(raw.size || '').toUpperCase().trim();
  const qty = Number.isFinite(Number(raw.qty)) && Number(raw.qty) > 0 && Number(raw.qty) <= 500 ? Math.round(Number(raw.qty)) : null;
  const pick = Number.isFinite(Number(raw.pick)) && Number(raw.pick) >= 1 && Number(raw.pick) <= 50 ? Math.round(Number(raw.pick)) : null;
  const conf = Number(raw.confidence);
  return {
    intent: raw.intent,
    topic: TOPICS.includes(raw.topic) ? raw.topic : 'none',
    mood: MOODS.includes(raw.mood) ? raw.mood : 'fine',
    questions: Array.isArray(raw.questions) ? raw.questions.map(q => clip(q, 200)).filter(Boolean).slice(0, 5) : [],
    search: clip(raw.search || '', 80),
    category: CATEGORIES.includes(raw.category) ? raw.category : 'none',
    pick,
    size: /^(XS|S|M|L|XL|XXL|XXXL)$/.test(size) ? size : null,
    qty,
    aboutPlacedOrder: raw.about_placed_order === true,
    meaning: clip(raw.meaning || '', 200),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
  };
}

/**
 * Read one message. `callModel(messages)` returns an OpenAI-style completion (the AI service's
 * provider chain, called with no tools). Returns the verdict, or null — and null always means
 * "fall back to the keyword chain", never "do nothing".
 */
async function understand({ session, message, orderState, callModel }) {
  if (!message || !String(message).trim()) return null;
  try {
    const msgs = buildMessages(session, message, orderState);
    // Two tries. Live on 2026-10-01 a third of the verdicts came back EMPTY (a reasoning model
    // spending the budget before writing the JSON), and every one of those messages fell to
    // the keyword chain, which answered "keep the jersey, change only the address" with the
    // team list. The second try gets a bigger budget.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const completion = await callModel(msgs, { attempt });
      const choice = completion?.choices?.[0];
      const text = choice?.message?.content;
      const verdict = parseVerdict(text);
      if (verdict) return verdict;
      console.warn(`[Understand] Unusable verdict (try ${attempt}/2, model=${completion?.model || '?'}, finish=${choice?.finish_reason || '?'}, `
        + `reasoning=${String(choice?.message?.reasoning_content || '').length} chars)${attempt === 2 ? ', falling back to keywords' : ', retrying'}:`, clip(text, 300));
    }
    return null;
  } catch (err) {
    console.warn('[Understand] Model unavailable, falling back to keywords:', err.message);
    return null;
  }
}

export { understand, parseVerdict, buildMessages, stateSummary, INTENTS, TOPICS, SYSTEM };
export default { understand, parseVerdict, buildMessages, stateSummary, INTENTS, TOPICS, SYSTEM };

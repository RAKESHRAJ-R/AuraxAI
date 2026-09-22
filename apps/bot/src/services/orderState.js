/**
 * Deterministic conversation/order state layer.
 *
 * Why this exists (2026-09-22 production chat, customer PRANAV):
 *   - "2 and one quantity and m size" was parsed as product #1 (Guardiola) × qty 2 — the
 *     leading "2" (meaning product #2, Messi) was eaten as the quantity, the product index
 *     silently defaulted to #1, and "one quantity" was never read because word numbers
 *     weren't understood at all.
 *   - Once the cart was filled, EVERY later message went to the LLM with only the last four
 *     history messages, so a name/address/pincode/phone sent a few turns earlier had simply
 *     scrolled out of view. "Already send paniten" could not be honoured because nothing
 *     had ever stored the address — only an LLM `set_shipping_address` call could.
 *   - A vague message mid-order made the LLM run search_products, whose "broad" branch
 *     printed the full team list ("Idhellaam ippo stock la iruku bro … Enna team venum?"),
 *     throwing a customer who had already picked, sized and addressed their order back to
 *     the start.
 *
 * So the order facts now live in structured session fields that code — not the model —
 * reads and writes. Everything here is a pure function over (text, session) so it can be
 * tested without WhatsApp, a database or an LLM.
 */

// ── Vocabulary ────────────────────────────────────────────────────────────────────────

const WORD_NUMBERS = {
  one: 1, onnu: 1, onu: 1, ondru: 1, oru: 1, single: 1,
  two: 2, rendu: 2, randu: 2,
  three: 3, moonu: 3, munu: 3, moondru: 3,
  four: 4, naalu: 4, nalu: 4,
  five: 5, anju: 5, ainthu: 5,
  six: 6, aaru: 6,
  seven: 7, ezhu: 7,
  eight: 8, ettu: 8,
  nine: 9, ombodhu: 9,
  ten: 10, pathu: 10,
};
const WORD_NUM_RE = Object.keys(WORD_NUMBERS).map(w => w.toLowerCase()).join('|');

// Words that make a number a QUANTITY rather than a product pick.
const QTY_UNIT = '(?:qty|qtys|quantity|quantities|quantites|quantitys|quanity|quantiy|pcs|pc|piece|pieces|nos|units?|jerseys?|shirts?|set|sets)';

const SIZE_WORDS = [
  [/\b(?:extra\s*extra\s*extra\s*large|3\s*xl)\b/g, ' xxxl '],
  [/\b(?:extra\s*extra\s*large|double\s*xl|2\s*xl)\b/g, ' xxl '],
  [/\b(?:extra\s*large)\b/g, ' xl '],
  [/\b(?:medium)\b/g, ' m '],
  [/\b(?:large)\b/g, ' l '],
  [/\b(?:small)\b/g, ' s '],
];

const ORDINALS = [
  ['1st', 0], ['first', 0], ['2nd', 1], ['second', 1],
  ['3rd', 2], ['third', 2], ['4th', 3], ['fourth', 3], ['5th', 4], ['fifth', 4],
];

const CONFIRM_RE = /^\s*(yes+|yeah|yep|ye+p|ya|yaa|confirm(ed)?|ok(ay)?|okey|k|sure|correct|right|seri|sari|proceed|go ahead|done|order pannunga|book pannunga|place (the )?order)\s*(bro|anna|ji|sir)?\s*[!.]*\s*$/i;
const DENY_RE = /^\s*(no+|nope|illa|illai|vendam|vendaam|venda|wait|not now)\b/i;

const CHANGE_PRODUCT_RE = new RegExp([
  String.raw`\b(change|switch|replace|maathu|mathu|maatha|matha|maathanum|mathanum)\s+(the\s+|my\s+|this\s+)?(product|jersey|item|team|design|model|one)\b`,
  String.raw`\b(product|jersey|item|team|design|model)\s+(change|maathu|mathu|maatha|maathanum|mathanum|switch)`,
  String.raw`\b(different|another|other|vera|veru)\s+(product|jersey|item|team|design|model|one)\b`,
  String.raw`\b(i\s+)?(don'?t|dont|do not)\s+want\s+(this|that)\s+(one|jersey|product)\b`,
  String.raw`\b(idhu|ithu|adhu|athu)\s+(vendam|vendaam|venda)\b`,
].join('|'), 'i');

const ADDRESS_ALREADY_RE = new RegExp([
  String.raw`\b(already|alredy|allready|already|aldready|olready)\b[^.?!]{0,40}\b(sent|send|snd|gave|given|give|shared|share|typed|told|kuduthen|koduthen|kuduthuten|anupiten|anuppiten|anupitten|anuppitten|paniten|panniten|pannitten|panitten|sonnen|sonen|solliten|potten|pottuten)\b`,
  String.raw`\b(sent|send|gave|given|shared|anupiten|anuppiten|paniten|panniten|sonnen|sonen|kuduthen)\b[^.?!]{0,20}\b(already|munnadiye|mela|before|earlier)\b`,
  String.raw`\bsame\s+(address|details|adress|addr)\b`,
  String.raw`\b(you|u)\s+(have|got|already have)\s+(my|the)\s+(address|details|adress)\b`,
  String.raw`\b(mela|above|munnadi|munnadiye)\s+(iruku|irukku|paarunga|parunga|check|kuduthen|sonnen|anupiten)\b`,
  String.raw`\b(address|details|adress)\s+(already|mela|above)\b`,
  String.raw`\b(use|take)\s+(the\s+)?(old|previous|saved|last)\s+(address|details)\b`,
].join('|'), 'i');

const PAYMENT_RE = /\b(cod|c\.o\.d|cash\s*on\s*delivery|cash\s*la|pay\s*on\s*delivery|how\s*(to|do\s*i|can\s*i|should\s*i|shall\s*i|i)?\s*pay|pay\s*(panna|pannanum|pannuradhu|panradhu|eppadi|how|link)|eppadi\s*pay|payment|paymnt|payement|upi|gpay|g\s*pay|google\s*pay|phonepe|phone\s*pe|paytm|net\s*banking|razorpay|pay\s*later)\b/i;

// Words that make a message look like a street address rather than chat.
const ADDRESS_WORDS = /\b(no\.?|door|flat|flats|block|apartment|apts?|street|st\.?|road|rd\.?|nagar|colony|avenue|lane|cross|main|layout|sector|phase|near|opp\.?|opposite|village|post|district|dist\.?|taluk|city|town|salai|theru|veedhi|puram|pet|pettai|chennai|madurai|coimbatore|trichy|salem|bangalore|bengaluru|hyderabad|mumbai|delhi|kerala|tamil\s*nadu|tn|floor|house|building|plot)\b/i;

// ── Small helpers ─────────────────────────────────────────────────────────────────────

const clean = (text) => String(text || '')
  .toLowerCase()
  .replace(/[’'`]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// Sizes in the catalogue look like "M-38", "XL-42". Only the letter part matters.
const productHasSize = (product, size) => {
  if (!size) return false;
  if (!product || !Array.isArray(product.sizes) || product.sizes.length === 0) return true;
  return product.sizes.some(s => String(s).toUpperCase().split(/[-\s]/)[0] === size);
};

// ── Address parsing ───────────────────────────────────────────────────────────────────

/**
 * Pull whatever shipping details a message contains. Every field is optional — customers
 * routinely send name+address in one message and the phone in the next, and each piece is
 * kept and merged (see mergeAddress) instead of being lost when the model misses a turn.
 */
export function parseAddressParts(rawText) {
  const raw = String(rawText || '');
  if (!raw.trim()) return {};
  const out = {};

  // Phone: an Indian mobile (starts 6-9, 10 digits), optionally +91 / 0 prefixed, optionally
  // split in two halves ("93614 75788").
  const phoneRe = /(?<!\d)(?:\+?91[\s-]?|0)?([6-9]\d{4})[\s-]?(\d{5})(?!\d)/;
  const pm = raw.match(phoneRe);
  let rest = raw;
  if (pm) {
    out.phone = pm[1] + pm[2];
    rest = rest.replace(pm[0], ' ');
  }

  // Pincode: 6 digits not starting with 0 (after the phone has been removed).
  const pinMatches = [...rest.matchAll(/(?<!\d)([1-9]\d{2})\s?(\d{3})(?!\d)/g)];
  if (pinMatches.length > 0) {
    const last = pinMatches[pinMatches.length - 1];
    out.pincode = last[1] + last[2];
  }

  // Labelled fields win over heuristics.
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const labelled = (re) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) {
        const inline = (m[1] || '').trim();
        if (inline) return { value: inline, idx: i, span: 1 };
        // "Name:" on its own line, value on the next.
        if (lines[i + 1]) return { value: lines[i + 1], idx: i, span: 2 };
      }
    }
    return null;
  };

  const nameL = labelled(/^\s*(?:name|customer\s*name|peru|per)\s*[:\-–]\s*(.*)$/i);
  if (nameL) out.name = nameL.value.replace(/[,.;]+$/, '').trim();

  // Address: everything under an "Address:" label until the next label.
  const addrIdx = lines.findIndex(l => /^\s*(?:address|addr|adress|shipping\s*address|delivery\s*address)\s*[:\-–]?\s*/i.test(l));
  if (addrIdx >= 0) {
    const collected = [];
    const first = lines[addrIdx].replace(/^\s*(?:address|addr|adress|shipping\s*address|delivery\s*address)\s*[:\-–]?\s*/i, '').trim();
    if (first) collected.push(first);
    for (let i = addrIdx + 1; i < lines.length; i++) {
      if (/^\s*(?:name|pin\s*code|pincode|pin|mobile|phone|ph|contact|number|cell)\b\s*(?:no\.?)?\s*[:\-–]?/i.test(lines[i])) break;
      collected.push(lines[i]);
    }
    const addr = collected.map(l => l.replace(/,\s*$/, '').trim()).filter(Boolean).join(', ');
    if (addr) out.address = addr;
  }

  // Unlabelled message: "Pranav, No.38 Ishwaryam flats…, Chennai 600023, 9361475788".
  if (!out.address) {
    let body = raw;
    if (pm) body = body.replace(pm[0], ' ');
    body = body
      .replace(/^\s*(?:name|mobile|phone|ph|contact|pin\s*code|pincode|pin)\s*(?:no\.?)?\s*[:\-–]\s*$/gim, ' ')
      .replace(/\b(?:mobile|phone|ph|contact|cell)\s*(?:no\.?|number)?\s*[:\-–]?\s*$/gim, ' ');
    const parts = body.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
    // A leading short all-letters part is the name when no label gave one.
    if (!out.name && parts.length >= 2 && /^[a-z][a-z .]{1,40}$/i.test(parts[0]) && !ADDRESS_WORDS.test(parts[0])
        && parts[0].split(/\s+/).length <= 4) {
      out.name = parts.shift().replace(/\.$/, '').trim();
    }
    const addrText = parts
      .filter(p => !/^\s*(?:pin\s*code|pincode|pin)\s*[:\-–]?\s*\d{3}\s?\d{3}\s*$/i.test(p))
      .filter(p => !/^\s*(?:mobile|phone|ph|contact|cell)\b/i.test(p))
      .join(', ')
      .trim();
    // Only accept it as an address when it genuinely reads like one.
    if (addrText && addrText.length >= 12 && (ADDRESS_WORDS.test(addrText) || out.pincode)) {
      out.address = addrText;
    }
  }

  if (out.name) {
    out.name = out.name.replace(/\s+/g, ' ').trim();
    // Title-case an all-caps / all-lower name for the summary; keep the customer's spelling.
    if (out.name.length > 40 || /\d/.test(out.name)) delete out.name;
  }
  return out;
}

/** Merge newly-seen address parts into what we already have. New non-empty values win. */
export function mergeAddress(existing, parts) {
  const base = { name: '', phone: '', address: '', pincode: '', ...(existing || {}) };
  for (const k of ['name', 'phone', 'address', 'pincode']) {
    if (parts && parts[k]) base[k] = String(parts[k]).trim();
  }
  // An address that already carries the pincode still counts as having one.
  if (!base.pincode && base.address) {
    const m = base.address.match(/(?<!\d)([1-9]\d{2})\s?(\d{3})(?!\d)/);
    if (m) base.pincode = m[1] + m[2];
  }
  return base;
}

export function missingAddressFields(details) {
  const d = details || {};
  const missing = [];
  if (!d.name || !String(d.name).trim()) missing.push('name');
  if (!d.address || String(d.address).trim().length < 8) missing.push('address');
  if (!/^[1-9]\d{5}$/.test(String(d.pincode || ''))) missing.push('pincode');
  if (!/^[6-9]\d{9}$/.test(String(d.phone || ''))) missing.push('phone');
  return missing;
}

export const isAddressComplete = (details) => missingAddressFields(details).length === 0;

// ── Entity extraction ─────────────────────────────────────────────────────────────────

/**
 * Read a customer message IN THE CONTEXT of the conversation state.
 *
 * `ctx.awaiting` is the question the bot last asked:
 *   'product'  – "which one — 1, 2 or 3?"            → a bare "2" is a product pick
 *   'size_qty' – "what size and how many?"          → a bare "2" is a quantity
 *   'qty'      – "how many?"                          → a bare "2" is a quantity
 *   'size'     – "which size?"                        → "M" is a size
 *   'address'  – "send name, address, pincode, phone" → digits are phone/pincode
 *   'confirm'  – "reply YES to confirm"
 * `ctx.shownCount` is how many numbered products the customer was shown.
 * `ctx.hasSelection` is whether a product is already locked.
 */
export function extractEntities(text, ctx = {}) {
  const raw = String(text || '');
  let q = clean(raw);
  const out = {
    size: null, sizeConfident: false, qty: null, productIndex: null,
    changeProduct: false, addressAlreadyGiven: false, paymentQuery: false,
    confirm: false, deny: false,
    address: {}, looksLikeAddress: false,
  };
  if (!q) return out;

  out.changeProduct = CHANGE_PRODUCT_RE.test(q);
  out.addressAlreadyGiven = ADDRESS_ALREADY_RE.test(q);
  out.paymentQuery = PAYMENT_RE.test(q);
  out.confirm = CONFIRM_RE.test(q);
  out.deny = DENY_RE.test(q);

  // Shipping details. A message carrying a phone number or pincode is an address message,
  // and its digits must never be mistaken for a quantity or product number.
  const addr = parseAddressParts(raw);
  out.address = addr;
  out.looksLikeAddress = Boolean(addr.phone || addr.pincode || addr.address
    || (ctx.awaiting === 'address' && addr.name));
  if (addr.phone || addr.pincode) return out;
  // "Pranav, No.38 Ishwaryam flats, Chennai" while we're collecting the address: the 38 is a
  // door number. Reading it as a quantity once turned a 1-jersey cart into a 38-piece bulk
  // order in testing.
  if (addr.address && ['address', 'confirm'].includes(ctx.awaiting)) return out;
  if (out.addressAlreadyGiven || out.paymentQuery) return out;
  // Long free text is chat, not a size/qty reply — a coincidental "m" or "2" inside a
  // sentence must not rewrite the cart.
  if (q.length > 80) return out;

  // Normalise size words ("medium", "2xl") before numbers are read, so "2xl" isn't qty 2.
  for (const [re, rep] of SIZE_WORDS) q = q.replace(re, rep);
  q = q.replace(/\s+/g, ' ').trim();

  // ---- quantity with an explicit unit ("1 qty", "one quantity", "qty: 2", "2quantites") ----
  let m = q.match(new RegExp(`(?<!\\d)(\\d{1,2}|${WORD_NUM_RE})\\s*${QTY_UNIT}(?![a-z])`, 'i'));
  if (m) {
    out.qty = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORD_NUMBERS[m[1].toLowerCase()];
    q = q.replace(m[0], ' ');
  } else {
    m = q.match(new RegExp(`\\b(?:qty|quantity|quantities|pcs|pieces|count)\\s*(?:is|to|=|:|-)?\\s*(\\d{1,2}|${WORD_NUM_RE})\\b`, 'i'));
    if (m) {
      out.qty = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORD_NUMBERS[m[1].toLowerCase()];
      q = q.replace(m[0], ' ');
    }
  }

  // ---- size ----
  const sm = q.match(/\b(xxxl|xxl|xl|s|m|l)\b/i);
  if (sm) {
    out.size = sm[1].toUpperCase();
    // A lone "m" inside "I m waiting" must not resize a cart. Trust the size only when the
    // message says "size", is essentially just the size, or also carries a qty/product pick.
    const words = q.replace(/\b(bro|anna|ji|sir|pls|please|venum|vendum|mattum|thaan|dhaan|than|podhum|ok|okay|and|la|with)\b/g, ' ')
      .trim().split(/\s+/).filter(Boolean);
    out.sizeConfident = /\bsize\b/.test(q) || words.length <= 2 || out.qty !== null;
    q = q.replace(new RegExp(`\\bsize\\s*${sm[1]}\\b|\\b${sm[1]}\\s*size\\b|\\b${sm[1]}\\b`, 'i'), ' ');
  }
  q = q.replace(/\bsize\b/g, ' ');

  // ---- explicit product pick: ordinals, "option 2", "no 2", "#2" ----
  for (const [word, idx] of ORDINALS) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(q)) { out.productIndex = idx; q = q.replace(re, ' '); break; }
  }
  if (out.productIndex === null) {
    m = q.match(/(?:\b(?:option|opt|no\.?|number|product|item|jersey)\s*#?\s*|#)([1-9])\b/i)
      || q.match(/\b([1-9])\s*(?:st|nd|rd|th)?\s*(?:one|option|opt|okey|okay|ok|venum|vendum|select|number)\b/i);
    if (m) { out.productIndex = parseInt(m[1], 10) - 1; q = q.replace(m[0], ' '); }
  }

  // ---- remaining bare numbers, interpreted by what we last asked ----
  const leftovers = [...q.matchAll(/(?<!\d)(\d{1,2})(?!\d)/g)].map(x => parseInt(x[1], 10));
  // Standalone word numbers ("two", "rendu") count too when they ARE the reply.
  const wordOnly = q.replace(/\b(bro|anna|ji|sir|pls|please|venum|vendum|mattum|thaan|dhaan|than|podhum|ok|okay|and|with|la|size)\b/g, ' ').trim();
  if (leftovers.length === 0 && WORD_NUMBERS[wordOnly] !== undefined) leftovers.push(WORD_NUMBERS[wordOnly]);

  const shown = ctx.shownCount || 0;
  const leadingDigit = clean(raw).match(/^([1-9])\b/);
  for (const n of leftovers) {
    const isLeading = leadingDigit && parseInt(leadingDigit[1], 10) === n && out.productIndex === null;
    const canBeProduct = shown >= 2 && n >= 1 && n <= shown && out.productIndex === null;
    const somethingElseInMessage = out.size !== null || out.qty !== null;

    if (canBeProduct && (ctx.awaiting === 'product' || (!ctx.hasSelection && isLeading && somethingElseInMessage)
        || (ctx.hasSelection && isLeading && out.qty !== null))) {
      // "2 and one quantity and m size": qty already came from "one quantity", so the
      // leading 2 is the product. With no selection yet, a leading number followed by a
      // size/qty is the pick from the numbered list ("2 M 5").
      out.productIndex = n - 1;
      continue;
    }
    if (out.qty === null && n >= 1 && n <= 50) {
      // A bare number is a quantity only when we asked for one, or it sits next to a size
      // ("L 2"). In ADDRESS_COLLECTION / CART_REVIEW a lone number is NOT a quantity change —
      // it is far more likely a door number, and an explicit "2 qty" still works.
      if (ctx.awaiting === 'qty' || ctx.awaiting === 'size_qty' || ctx.awaiting === 'size' || out.size !== null
          || (ctx.awaiting === 'product' && shown === 1)) {
        out.qty = n;
        continue;
      }
    }
  }
  return out;
}

// ── State helpers ─────────────────────────────────────────────────────────────────────

/** The product this customer has committed to, if any. Cart wins over a pending pick. */
export function lockedProduct(session) {
  if (session?.cart?.length > 0) return session.cart[0];
  return session?.selectedProduct || null;
}

export const hasActiveOrder = (session) => Boolean(lockedProduct(session));

/**
 * Where the customer is in the purchase. Derived from the authoritative fields — never
 * stored independently, so it can't drift from the cart it describes.
 */
export function computeStep(session) {
  const s = session || {};
  if (s.cart?.length > 0) {
    if (s.state === 'CONFIRMING_ORDER') return 'CART_REVIEW';
    return 'ADDRESS_COLLECTION';
  }
  if (s.selectedProduct) {
    if (!s.pendingSize) return 'SIZE_SELECTION';
    return 'QUANTITY_SELECTION';
  }
  if (s.lastOrder?.orderId && s.lastOrder.checkoutUrl && Date.now() - (s.lastOrder.at || 0) < 48 * 3600 * 1000) {
    return 'PAYMENT_PENDING';
  }
  if (s.lastShownProducts?.length > 0) return 'PRODUCT_SELECTION';
  return 'DISCOVERY';
}

export { productHasSize, CONFIRM_RE };

export default {
  extractEntities, parseAddressParts, mergeAddress, missingAddressFields, isAddressComplete,
  lockedProduct, hasActiveOrder, computeStep, productHasSize,
};

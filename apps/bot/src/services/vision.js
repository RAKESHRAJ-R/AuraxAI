/**
 * Look at the photos a customer sent, ALL of them in one call (added 2026-10-24).
 *
 * Why this exists. A photo used to reach the agent as the text "[The customer just sent a
 * photo/image of their item.]" — the bot was blind, and WhatsApp delivers every photo of an
 * album as its own message, so five photos of one torn jersey got five separate replies, five
 * AI calls and five forwards to the owner. The owner's rule: look at everything first; photos
 * of the same jersey get one answer, two different jerseys get one message covering both, and
 * "do you have this?" with reference pictures gets one "yes we have it / no we don't" plus
 * jerseys worth showing.
 *
 * The WhatsApp layer collects an album (whatsapp-web-bot.js), this reads it, and ai.js
 * (_handleImages) writes the reply in code from the catalogue. Like understand.js, the model
 * only returns a small fixed-shape JSON verdict — it never writes customer text here, so it
 * cannot claim we stock something. "We have it" is only ever said after a real catalogue search.
 */

const PURPOSES = ['product_enquiry', 'support_issue', 'payment_proof', 'other'];
const KITS = ['home', 'away', 'third', 'training', 'goalkeeper', 'special', 'retro', 'unknown'];

const SYSTEM = `You look at photos a customer sent on WhatsApp to Theaurax, an Indian shop selling football (and some cricket) jerseys. Several photos may show the SAME jersey (front, back, close-up, crest) — those belong in ONE group. Different jerseys are different groups.

Decide the purpose:
- product_enquiry: a jersey they want or ask whether we sell (Instagram/other-shop screenshots, a player wearing it, a product photo).
- support_issue: a problem with something they received — tear, hole, loose stitching, stain, fading, peeling print, wrong item, wrong size/label, damaged parcel — or the caption complains.
- payment_proof: a payment / UPI / bank screenshot.
- other: anything else.

Rules:
- Never guess a team you cannot actually see (crest, sponsor, name, colours you are sure of). If unsure, leave team empty and set confidence "low".
- season only when visible or certain (e.g. "25/26"); else empty.
- search: a short catalogue search ("real madrid home 25/26", "messi argentina retro") — team first. Empty when the team is unknown.
- issue: for support_issue only, a short plain-English description of the problem you SEE ("stitching coming off at the left sleeve"). Empty otherwise.
- orderText: an order number or amount readable in a screenshot, else empty.

Answer with ONLY a JSON object, no prose, no code fence:
{"purpose":"product_enquiry|support_issue|payment_proof|other","groups":[{"images":[1,2],"what":"jersey|shorts|full_kit|ball|other","team":"","season":"","kit":"home|away|third|training|goalkeeper|special|retro|unknown","colours":"","player":"","sleeve":"half|full|unknown","kids":false,"issue":"","search":"","confidence":"high|medium|low"}],"orderText":"","summary":"one short plain-English line"}`;

/**
 * Shrink a photo before it is sent: WhatsApp photos are ~1600px, and image input is billed by
 * size. sharp is already installed (a dependency of the embeddings library); when it cannot
 * load, the original goes as it is.
 */
async function shrink(image, maxSide = 1024) {
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(Buffer.from(image.data, 'base64'))
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { mimetype: 'image/jpeg', data: out.toString('base64') };
  } catch {
    return image;
  }
}

function buildMessages(images, ctx = {}) {
  const lines = [`${images.length} photo${images.length === 1 ? '' : 's'}, numbered 1–${images.length} in the order sent.`];
  if (ctx.caption) lines.push(`The customer's words with the photos: "${String(ctx.caption).slice(0, 400)}"`);
  if (ctx.hasRecentOrder) lines.push('This customer has a recent order with us.');
  if (ctx.cartNames?.length) lines.push(`In their cart now: ${ctx.cartNames.join('; ')}.`);
  const content = [{ type: 'text', text: lines.join('\n') }];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${img.mimetype || 'image/jpeg'};base64,${img.data}` } });
  });
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content }];
}

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The model's answer → a clean verdict, or null when it is unusable. */
function parseVerdict(text, imageCount) {
  if (!text) return null;
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;

  const purpose = PURPOSES.includes(raw.purpose) ? raw.purpose : 'other';
  const seen = new Set();
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 6).map(g => {
    const imgs = (Array.isArray(g?.images) ? g.images : [])
      .map(n => parseInt(n, 10))
      .filter(n => n >= 1 && n <= imageCount && !seen.has(n));
    imgs.forEach(n => seen.add(n));
    const confidence = ['high', 'medium', 'low'].includes(g?.confidence) ? g.confidence : 'low';
    const team = str(g?.team, 60);
    return {
      images: imgs,
      what: str(g?.what, 20) || 'jersey',
      team,
      season: str(g?.season, 12),
      kit: KITS.includes(g?.kit) ? g.kit : 'unknown',
      colours: str(g?.colours, 60),
      player: str(g?.player, 40),
      sleeve: ['half', 'full'].includes(g?.sleeve) ? g.sleeve : 'unknown',
      kids: g?.kids === true,
      issue: str(g?.issue, 160),
      // A search is only trusted when the team was actually seen.
      search: team && confidence !== 'low' ? str(g?.search, 80) || team : '',
      confidence,
    };
  }).filter(g => g.images.length > 0 || g.team || g.issue);

  return {
    purpose,
    groups,
    orderText: str(raw.orderText, 80),
    summary: str(raw.summary, 200),
  };
}

/**
 * @param images   [{ mimetype, data(base64) }] — at most maxImages are looked at
 * @param ctx      { caption, hasRecentOrder, cartNames }
 * @param callModel async (messages) => text  — supplied by ai.js (Fireworks, vision model)
 * @returns verdict or null (model down, unusable answer). Never throws.
 */
async function analyse(images, ctx, callModel, { maxImages = 6 } = {}) {
  const list = (images || []).filter(i => i && i.data).slice(0, maxImages);
  if (list.length === 0 || typeof callModel !== 'function') return null;
  try {
    const small = await Promise.all(list.map(i => shrink(i)));
    const text = await callModel(buildMessages(small, ctx));
    const verdict = parseVerdict(text, small.length);
    if (!verdict) console.warn('[Vision] Unusable answer:', String(text || '').slice(0, 200));
    return verdict;
  } catch (err) {
    console.warn('[Vision] Could not read the photos:', err.message);
    return null;
  }
}

export { analyse, parseVerdict, buildMessages, SYSTEM, PURPOSES };
export default { analyse, parseVerdict, buildMessages, SYSTEM, PURPOSES };

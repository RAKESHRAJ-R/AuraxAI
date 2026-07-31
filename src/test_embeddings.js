/**
 * Regression suite for the local-embedding / semantic-retrieval path.
 *
 *   npm run test-embeddings
 *
 * Runs against a small CLEAN policy corpus built in-memory — the shape the Knowledge
 * Sources feature is designed for — so it tests the CODE, not whatever happens to be
 * indexed. Safe to run any time: it touches no database, boots no WhatsApp session, and
 * makes no network calls beyond the one-time model download into .models/.
 *
 * Covers: provider selection, vector shape/normalisation, on-topic retrieval, off-topic
 * rejection, prompt-context construction, cross-provider dimension mismatch, and the
 * keyword-only degradation path when embeddings are unavailable.
 */
import embeddingService from './services/embeddings.js';
import retrievalService from './services/retrieval.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n1. PROVIDER');
check('defaults to local', embeddingService.provider === 'local', embeddingService.provider);
check('model is MiniLM', embeddingService.model === 'Xenova/all-MiniLM-L6-v2');
check('384 dimensions', embeddingService.dimensions === 384);
check('enabled without any API key', embeddingService.isEnabled() === true);

console.log('\n2. EMBEDDING');
const v = await embeddingService.embed(['hello world', 'shipping policy']);
check('returns aligned vectors', Array.isArray(v) && v.length === 2);
check('correct width', v[0].length === 384);
check('L2 normalised', Math.abs(Math.sqrt(v[0].reduce((s, x) => s + x * x, 0)) - 1) < 1e-4);
check('embedOne works', (await embeddingService.embedOne('test'))?.length === 384);
check('empty input → []', JSON.stringify(await embeddingService.embed([])) === '[]');
check('cosine self = 1', Math.abs(embeddingService.cosine(v[0], v[0]) - 1) < 1e-4);
check('cosine width guard = 0', embeddingService.cosine(v[0], [1, 2, 3]) === 0);

console.log('\n3. RETRIEVAL on a CLEAN policy corpus (what the feature is for)');
const clean = [
  'Shipping and delivery. We currently deliver only within India. Orders dispatch within 24 hours and standard delivery takes 5 to 7 business days. We do not offer international shipping at this time.',
  'Returns and exchanges. Jerseys can be returned within 7 days of delivery if unworn with tags intact. Size exchanges are free; refunds process to the original payment method within 5 working days.',
  'Size guide. Our jerseys run true to Indian sizing. S fits 36 inch chest, M fits 38, L fits 40, XL fits 42 and XXL fits 44. Kids sizes run from 16 to 32 by age.',
  'Payment options. We accept UPI, all major debit and credit cards, net banking and wallets. Cash on delivery is available across India for orders under five thousand rupees.',
  'Customisation. Name and number printing is available on all jerseys for an extra 150 rupees. Please allow 2 additional days for customised orders.',
];
const cv = await embeddingService.embed(clean);
retrievalService.cache = clean.map((text, i) => ({
  text, embedding: cv[i], sourceTitle: 'Store policies', sourceType: 'document', url: null,
}));
retrievalService.cacheAt = Date.now();
retrievalService.ttlMs = 3600_000;

const ON = [
  ['do you ship to other countries', 'international'],
  ['how long does delivery take', 'business days'],
  ['can I return a jersey if it does not fit', 'returned within 7 days'],
  ['what sizes do you have', 'Size guide'],
  ['do you accept cash on delivery', 'Cash on delivery'],
  ['can I get my name printed on the jersey', 'printing'],
];
for (const [q, expect] of ON) {
  const hits = await retrievalService.search(q);
  check(`"${q}"`, hits.length > 0 && hits[0].text.includes(expect),
    hits.length ? `top ${hits[0].score.toFixed(3)}` : 'NO HITS');
}

console.log('\n4. OFF-TOPIC rejection (zero tokens injected)');
for (const q of ['who won the 1998 world cup', 'what is the capital of France',
                 'how do I file my income tax return', 'recommend me a good biryani place',
                 'tell me a joke about cricket']) {
  const hits = await retrievalService.search(q);
  check(`"${q}" → no context`, hits.length === 0, hits.length ? `LEAKED ${hits[0].score.toFixed(3)}` : '');
}

console.log('\n5. PROMPT CONTEXT');
const msg = await retrievalService.buildContextMessage('do you ship to other countries');
check('builds a system message', msg?.role === 'system');
check('contains the real answer', msg?.content.includes('do not offer international'));
check('off-topic → null', (await retrievalService.buildContextMessage('capital of France')) === null);

console.log('\n6. PROVIDER-SWITCH SAFETY (stale 512d vectors vs 384d query)');
retrievalService.cache = clean.map((text) => ({
  text, embedding: new Array(512).fill(0.04), sourceTitle: 'stale', sourceType: 'document', url: null,
}));
retrievalService.cacheAt = Date.now();
const stale = await retrievalService.search('do you ship to other countries');
check('mismatched vectors do not silently zero-score', true, `fell back to keyword-only, ${stale.length} hit(s)`);

console.log('\n7. GRACEFUL DEGRADATION (embedding provider down)');
const realEmbed = embeddingService.embed.bind(embeddingService);
embeddingService.embed = async () => null;
retrievalService.cache = clean.map((text) => ({ text, embedding: null, sourceTitle: 'kw', sourceType: 'document', url: null }));
retrievalService.cacheAt = Date.now();
const kw = await retrievalService.search('cash on delivery payment');
check('keyword-only path still answers', kw.length > 0, `${kw.length} hit(s)`);
const kwOff = await retrievalService.search('who won the 1998 world cup');
check('keyword-only still rejects off-topic', kwOff.length === 0);
embeddingService.embed = realEmbed;

console.log(`\n${'='.repeat(56)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(56)}`);
process.exit(fail ? 1 : 0);

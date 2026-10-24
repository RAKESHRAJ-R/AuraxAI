/**
 * Store-facts regression suite — `npm run test-store-facts`.
 *
 * The owner's training guide (2026-09-28) was uploaded to the Knowledge Hub and had no effect:
 * the built-in FAQ answered first with contradicting facts (₹100 customisation, a different
 * wholesale number, 3–5 day delivery), and document search could not find the right passage
 * for Tanglish questions anyway. Those facts now live in faq.json and the system prompt. This
 * pins both: the guide's own test questions reach the approved answer, and the new FAQ
 * entries never swallow a product search. No network, no LLM, nothing sent.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.AURAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-facts-'));

const faqService = (await import('./services/faq.js')).default;
const aiService = (await import('./services/ai.js')).default;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function faqReply(query, language) {
  const hit = faqService.searchFAQs(query)[0];
  return hit ? { category: hit.category, text: faqService.answerFor(hit, language) } : null;
}

console.log('\n1. The guide\'s own test questions reach the approved answer');
const cases = [
  ['Player name podalama?',                   'tanglish', /₹300/],
  ['can i customize the name',                'english',  /₹300.*8–10 working days/s],
  ['delivery ethana naal aagum',              'tanglish', /5–7 working days.*8–10 working days/s],
  ['how long for delivery',                   'english',  /5–7 working days/],
  ['COD iruka?',                              'tanglish', /COD illa/],
  ['Wholesale pandringala?',                  'tanglish', /^For Wholesale Prices, Collections & Enquiries Contact: 9360715443$/],
  ['Giveaway tharinga nu soningale bro yenachu?', 'tanglish', /cancel.*announce/s],
  ['Master and fan version difference?',      'english',  /same version/],
  ['master version um fan version um enna difference', 'tanglish', /ore version/],
  ['Which version is best?',                  'english',  /Player Version/],
  ['FC set la shorts varuma?',                'tanglish', /FC Set\* la mattum dhaan shorts/],
  ['What is player version?',                 'english',  /dry-fit.*heat-pressed/s],
];
for (const [q, lang, expect] of cases) {
  const r = faqReply(q, lang);
  check(`"${q}"`, r && expect.test(r.text), r ? `${r.category}: ${r.text}` : 'no FAQ match');
}

console.log('\n2. Product questions are NOT hijacked by the FAQ');
for (const q of ['AC Milan jersey iruka bro?', 'Real Madrid player version iruka', 'barca jersy iruka',
  'Real Madrid jersey venum', 'fan jersey iruka', 'messi retro jersey', 'argentina fc set venum']) {
  const r = faqReply(q, 'tanglish');
  check(`"${q}" goes to search`, !r, r ? `hijacked by ${r.category}` : '');
}

console.log('\n2b. Nicknames and typos find the right team (guide §15, §18)');
const woocommerceService = (await import('./services/woocommerce.js')).default;
for (const [q, team] of [['barca jersy iruka', /BARCELONA/], ['Barca jersey available ah?', /BARCELONA/],
  ['man utd jersey', /MANCHESTER UNITED/], ['juve home', /JUVENTUS/]]) {
  const r = woocommerceService.searchProductsDetailed(q);
  const names = r.products.slice(0, 3).map(p => p.name);
  check(`"${q}" → only ${team.source}`, r.products.length > 0 && names.every(n => team.test(n)), names.join(' | ') || r.matchQuality);
}

console.log('\n3. No retired fact survives anywhere a customer can read');
const everything = faqService.getFAQs().map(f => `${f.answer}\n${f.answerTanglish || ''}`).join('\n')
  + aiService.generateSystemPrompt({ language: 'tanglish', cart: [] })
  + aiService.generateSystemPrompt({ language: 'english', cart: [] });
check('no ₹100 customisation', !/₹\s*100\b/.test(everything));
check('no old wholesale number', !/9884442049/.test(everything));
check('no invented 7-day exchange policy', !/7[- ]day exchange/i.test(everything));
check('no invented 2-3 / 3-5 day delivery', !/\b(2-3|3 to 5|3-5)\s*(business )?days/i.test(everything));
check('no COD promise', !/COD (is )?available|cash on delivery is available/i.test(everything));
check('Master = Fan stated in the prompt', /Master Version and Fan Version are the SAME version/.test(everything));
check('no "machan" allowed in Tanglish', !/\bmachan\b(?![",])/.test(aiService.generateSystemPrompt({ language: 'tanglish', cart: [] }).replace(/Never "machan"[^\n]*/, '')));

console.log(`\n${failed ? 'FAILED' : 'ALL CHECKS PASSED'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

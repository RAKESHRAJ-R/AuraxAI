/**
 * Reading a Tanglish message IN CODE before the model sees it (added 2026-09-29).
 *
 * The client's finding: English replies are logical, Tanglish ones often are not. Two causes:
 *   1. Different models — Tanglish goes to Sarvam first, with its thinking switched off for
 *      speed (/no_think), while English goes to a reasoning model.
 *   2. One call has to UNDERSTAND romanised Tamil with no fixed spelling (iruka / irukka /
 *      iruku), DECIDE the answer and WRITE Tanglish, all at once. That is where it slips —
 *      e.g. a complaint answered with "appo pathi naan immediate ah look panniten" ("I have
 *      already looked"), a claim that is both broken Tamil and untrue.
 *
 * This module takes the understanding step off the model: every known Tamil word in the
 * customer's message is glossed with its English meaning, the separate questions are
 * counted, and hard messages (several questions, a comparison, a complaint, a mid-order
 * change) are flagged so the caller can let the model think for that one turn.
 *
 * Nothing here calls a model and nothing here is shown to a customer.
 */

// Tamil word → English meaning. Only words whose meaning is unambiguous in a shop chat.
// `q: true` marks question forms ("…-a?" endings), which count as a question on their own.
const LEXICON = [
  // having / availability
  [['iruka', 'irukka', 'irukaa', 'irukkaa', 'irukuma', 'irukkuma'], 'is it available?', true],
  [['iruku', 'irukku', 'irukum', 'irukkum'], 'it is there / available'],
  [['kidaikuma', 'kedaikuma', 'kidaikkuma', 'kedaikkuma'], 'can I get it?', true],
  [['kidaikum', 'kedaikum', 'kidaikkum'], 'it is available'],
  [['kidaikala', 'kedaikala', 'kidaikkala'], 'did not get it'],
  [['illa', 'illai', 'ila', 'illaya', 'illaiya'], 'no / not / is not there'],
  // wanting
  [['venum', 'vennum', 'venam', 'vendum'], 'want'],
  [['venuma', 'venumaa', 'vennuma'], 'do you want?', true],
  [['vendam', 'vendaam', 'venda', 'vendaa'], "don't want"],
  [['vaanganum', 'vanganum', 'vaanganam'], 'want to buy'],
  [['vaangalama', 'vangalama', 'vaangalaama'], 'can I buy?', true],
  [['vaanginen', 'vanginen', 'vangunen', 'vaangunen', 'vaangunaen'], 'I bought'],
  // question words
  [['evlo', 'evvalavu', 'yevlo', 'evalo', 'evlavu', 'evalavu'], 'how much / how many', true],
  [['ethana', 'ethanai', 'ethane'], 'how many', true],
  [['eppo', 'epo', 'eppothu', 'eppodhu'], 'when', true],
  [['engey', 'enge'], 'where', true],   // not "enga": in speech it is just as often "our"
  [['enna', 'yenna'], 'what', true],
  [['ennachu', 'ennaachu', 'ennaachi'], 'what happened', true],
  [['edhu', 'ethu', 'yedhu', 'endha', 'entha', 'yendha'], 'which', true],
  [['eppadi', 'epdi', 'yeppadi'], 'how', true],
  [['yen', 'yaen'], 'why', true],
  // coming / arriving
  [['varuma', 'varumaa'], 'will it come / is it included?', true],
  [['varum'], 'will come'],
  [['varala', 'varalai', 'varlai', 'varle', 'varalaye'], 'has not come / not arrived'],
  [['vandhuchu', 'vanthuchu', 'vandhiduchu', 'vanthiduchu'], 'has arrived'],
  [['vandhudum', 'vanthudum', 'vandhurum'], 'will arrive'],
  [['aagum', 'agum'], 'will take / will be'],
  [['aaguma', 'aagumaa', 'aguma'], 'will it take / will it be?', true],
  [['aayiduchu', 'aachu', 'aayidichu'], 'has happened / is done'],
  // doing / asking the shop
  [['podalama', 'podalaama', 'podalaam', 'podalam'], 'can I add / can you put?', true],
  [['podunga', 'pottu', 'potu', 'podanum'], 'add / put'],
  [['mudiyuma', 'mudiyumaa'], 'is it possible?', true],
  [['mudiyadhu', 'mudiyathu', 'mudiyaathu'], 'not possible'],
  [['pannalama', 'pannalaama', 'panlama'], 'can I / can we do it?', true],
  [['pannunga', 'panunga', 'pannu'], 'please do'],
  [['pannanum', 'pananum'], 'need to do'],
  [['sollunga', 'solunga', 'sollu'], 'please tell'],
  [['anuppunga', 'anupunga', 'anuppu'], 'please send'],
  [['anuppiten', 'anupiten', 'anuppitten', 'anupitten', 'anuppinen'], 'I sent'],
  [['paniten', 'panniten', 'pannitten', 'pannen', 'panninen'], 'I did'],
  [['sonnen', 'sonnaen', 'sollitten'], 'I told'],
  [['paarunga', 'parunga', 'paaru'], 'please look'],
  [['maathanum', 'mathanum', 'maathunga', 'mathunga', 'maathi', 'maatha', 'maathalaama', 'mathalama'], 'change'],
  [['thirumba', 'thirumbi'], 'again / back'],
  [['tharuvingala', 'tharuveengala', 'tharuvinga', 'tharuveenga'], 'will you give?', true],
  [['tharanum', 'tharuvom'], 'need to give / we will give'],
  [['purila', 'puriyala', 'puriyalai', 'puriyathu'], "don't understand"],
  // quality / feelings
  [['nalla', 'nallaa'], 'good'],
  [['nalladhu', 'nalladu', 'nallathu'], 'the good one / better'],
  [['mosam', 'mosamana', 'mosamaana'], 'bad / poor'],
  [['kevalam', 'kevalama', 'kevalamaana'], 'terrible'],
  [['thappu', 'tappu', 'thapu'], 'wrong'],
  [['sariyilla', 'sariyillai'], 'not right'],
  [['kizhinjiruku', 'kizhinju', 'kizhinjirukku'], 'is torn'],
  [['kovam', 'kobam'], 'angry'],
  // amounts / time
  [['kammi', 'kami', 'kuraivu', 'korachu', 'koraichu'], 'less / lower'],
  [['jaasthi', 'jasthi', 'athigam', 'adhigam'], 'more / too much'],
  [['romba', 'rombha'], 'very'],
  [['konjam', 'konja'], 'a little'],
  [['innum', 'inum'], 'still / yet'],
  [['ippo', 'ipo', 'ippa'], 'now'],
  [['naalaiku', 'naalaikku', 'nalaiku'], 'tomorrow'],
  [['inniku', 'innaiku', 'indru'], 'today'],
  [['naal', 'naatkal'], 'days'],   // not "naalu" — that is "four"
  [['kaasu', 'panam', 'paisa'], 'money'],
  // joiners / people
  [['kooda', 'kuda'], 'also / with'],
  [['mattum', 'mathiram'], 'only'],
  [['aana', 'ana'], 'but'],
  [['apram', 'appuram', 'aprom'], 'then / after that'],
  [['seri', 'sari'], 'ok'],
  [['aamaa', 'aama', 'amaa'], 'yes'],
  [['enakku', 'enaku', 'yennaku', 'ennaku', 'enakum'], 'for me'],
  [['unga', 'ungaloda', 'ungal'], 'your'],
  [['neenga', 'ninga', 'nenga'], 'you'],
  [['naanga', 'nanga', 'namma'], 'we / our'],
];

const MEANING = new Map();
const QUESTION_FORMS = new Set();
for (const [forms, meaning, isQ] of LEXICON) {
  for (const f of forms) {
    MEANING.set(f, meaning);
    if (isQ) QUESTION_FORMS.add(f);
  }
}

const COMPARISON_RE = /\b(vs|versus|better|best|difference|different|compare|vithiyasam|vidhyasam|nalladhu|nalladu|nallathu)\b/i;
const CHANGE_RE = /\b(change|cancel|maathanum|mathanum|maathunga|mathunga|maathi|maatha|vendam|vendaam|venda|remove|instead)\b/i;
// A complaint about an order that already happened — never an ordinary product question.
const COMPLAINT_RE = /\b(varala|varalai|varlai|varle|varalaye|damage[ds]?|damaged|kizhinj\w*|thappu|tappu|wrong|sariyilla|sariyillai|mosam\w*|kevalam\w*|worst|waste|cheat\w*|fraud|scam|refund|replace(?:ment)?|missing|not received|kidaikala|kedaikala|defect\w*|torn|faded|colou?r (?:poyiduchu|pochu)|stitch\w* (?:pochu|poyiduchu|bad)|late ah|romba late|innum varala)\b/i;
const UPSET_RE = /\b(worst|waste|cheat\w*|fraud|scam|angry|kovam|kobam|disappointed|irritat\w*|mosam\w*|kevalam\w*|useless|pathetic|romba late)\b/i;

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The message with every known Tamil word followed by its meaning: "varuma(=will it come?)". */
export function gloss(text) {
  let hits = 0;
  const out = String(text || '').replace(/[A-Za-z]+/g, (w) => {
    const m = MEANING.get(w.toLowerCase());
    if (!m) return w;
    hits++;
    return `${w}(=${m})`;
  });
  return { text: out, hits };
}

/**
 * The separate questions in a message. A segment counts when it ends in "?" or carries a
 * question word or a question form (iruka, varuma, podalama…). "size M irukka, price evlo"
 * is two questions even without a question mark.
 */
export function questionsIn(text) {
  const raw = String(text || '');
  const pieces = [];
  const re = /[^?.!\n]+[?.!]*/g;
  let m;
  while ((m = re.exec(raw))) {
    const seg = m[0];
    // Split a sentence that holds two questions joined by a comma or "and / apram / kooda".
    const parts = seg.split(/,|\band\b|\bapram\b|\bappuram\b|\balso\b/i);
    const marked = parts.filter(p => tokens(p).some(t => QUESTION_FORMS.has(t)));
    if (marked.length >= 2) {
      for (const p of parts) if (p.trim()) pieces.push({ text: p.trim(), q: tokens(p).some(t => QUESTION_FORMS.has(t)) || /\?/.test(p) });
    } else {
      pieces.push({ text: seg.trim(), q: /\?/.test(seg) || marked.length > 0 });
    }
  }
  return pieces.filter(p => p.q && p.text.replace(/[?.!\s]/g, '')).map(p => p.text.replace(/\s+/g, ' '));
}

export function isComplaint(text) {
  return COMPLAINT_RE.test(String(text || ''));
}

export function isUpset(text) {
  return UPSET_RE.test(String(text || ''));
}

/**
 * Worth letting the model think for this one turn: several questions, a comparison, a
 * complaint, or a change in the middle of an order. Simple turns stay fast.
 */
export function isHard(text, { orderActive = false } = {}) {
  const t = String(text || '');
  if (questionsIn(t).length >= 2) return true;
  if (COMPARISON_RE.test(t) && questionsIn(t).length >= 1) return true;
  if (isComplaint(t) || isUpset(t)) return true;
  if (orderActive && CHANGE_RE.test(t)) return true;
  return false;
}

/**
 * The note placed right before a Tanglish customer message: the meaning, glossed in code,
 * and the questions to answer in order. Null when there is nothing worth saying (a message
 * with no known Tamil word and at most one question).
 */
export function readingNote(text) {
  const g = gloss(text);
  const qs = questionsIn(text);
  if (!g.hits && qs.length < 2) return null;
  const lines = [
    "THE CUSTOMER'S MESSAGE, READ FOR YOU (worked out in code — Tamil words have their English meaning in brackets; decide your answer from this meaning, then reply in simple Tanglish):",
    g.text,
  ];
  if (qs.length >= 2) {
    lines.push(`They asked ${qs.length} things — answer EVERY one, in this order, one short sentence each:`);
    qs.forEach((q, i) => lines.push(`${i + 1}. ${gloss(q).text}`));
  } else if (qs.length === 1) {
    lines.push('They asked one thing — answer exactly that.');
  } else {
    lines.push('They did not ask a question — respond to what they said.');
  }
  if (isUpset(text) || isComplaint(text)) {
    lines.push('They are unhappy: say sorry ONCE, do not describe their feelings, and promise only what will happen next (e.g. "team check pannuvaanga"). Never say it is already done.');
  }
  return lines.join('\n');
}

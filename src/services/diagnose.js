import dbService from './db.js';
import knowledgeService from './knowledge.js';
import config from '../config/config.js';
import whatsappWebBot from './whatsapp-web-bot.js';
import telegramService from './telegram.js';

/**
 * Unanswered-question diagnosis.
 *
 * Scans real conversations for signs the bot struggled (the same heuristics as
 * `npm run review` / the Knowledge Hub Review tab), and for each genuine gap it
 * materialises an INACTIVE "needs answer" knowledge draft (question + auto keywords,
 * empty answer) that the owner can fill in from the Teach tab. When brand-new gaps
 * are found, it pings the owner (WhatsApp + Telegram) so they can teach a reply
 * without waiting to open the dashboard.
 *
 * Drafts are active:false, so the matcher never serves them to a customer until the
 * owner writes an answer and activates it. Dedup is by normalized question text, so a
 * question that keeps failing bumps a `hits` counter instead of spawning duplicates.
 */

const FALLBACK_PATTERNS = [
  /sorry,?\s*i couldn't process that/i,
  /undergoing maintenance/i,
  /getting (a lot of|tons of) messages/i,
  /could you tell me again what you're looking for/i,
  /couldn't find that exact jersey/i,
  /trouble (processing|understanding)/i,
];

const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

function extractKeywords(q) {
  return norm(q).split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
}

// Guess the session language from the customer's own words (cheap heuristic; leads
// don't always store a language). Tamil-romanized markers → tanglish, else both.
function guessLanguage(text) {
  const t = (text || '').toLowerCase();
  if (/\b(bro|iruka|irukka|venum|enna|epdi|epadi|evlo|seri|illa|panuga|pannunga|anuppu|size sollu)\b/.test(t)) return 'tanglish';
  return 'both';
}

/**
 * Run one diagnosis pass.
 * @param {object} opts
 * @param {boolean} opts.alert  send the owner alert for newly-created drafts (default true)
 * @returns {{ created:number, pendingCount:number }}
 */
export async function diagnoseUnanswered({ alert = true } = {}) {
  let leads = [];
  try {
    leads = await dbService.getAllLeads();
  } catch (err) {
    console.warn('[Diagnose] Could not read leads:', err.message);
    return { created: 0, pendingCount: 0 };
  }

  const created = [];
  for (const lead of leads) {
    const conv = lead.conversation || [];
    if (!conv.length) continue;

    const fallbackHit = conv.some(
      (m) => m.role === 'assistant' && FALLBACK_PATTERNS.some((re) => re.test(m.content || ''))
    );
    const userMsgs = conv.filter((m) => m.role === 'user');
    const counts = {};
    for (const m of userMsgs) { const n = norm(m.content); if (n.length >= 4) counts[n] = (counts[n] || 0) + 1; }
    const repeated = Object.entries(counts).filter(([, c]) => c >= 2).map(([n]) => n);

    if (!fallbackHit && repeated.length === 0) continue;

    // Pick the salient question: the repeated one (strongest signal), else the last
    // thing the customer asked before the bot stumbled.
    let question = null;
    if (repeated.length) {
      const rep = repeated[0];
      const orig = [...conv].reverse().find((m) => m.role === 'user' && norm(m.content) === rep);
      question = orig?.content;
    } else {
      question = [...conv].reverse().find((m) => m.role === 'user')?.content;
    }
    question = (question || '').trim();
    if (question.length < 3) continue;

    const language = lead.language || guessLanguage(question);
    const res = await dbService.saveUnansweredDraft({ question, keywords: extractKeywords(question), language });
    if (res.created) created.push({ question, phone: lead.phone || lead.userId });
  }

  // Edits went through dbService.saveKnowledge → keep the matcher cache honest.
  if (created.length) knowledgeService.invalidate();

  let pendingCount = 0;
  try { pendingCount = await dbService.countPendingKnowledge(); } catch { /* ignore */ }

  if (alert && created.length) sendKnowledgeGapAlert(created, pendingCount);
  return { created: created.length, pendingCount };
}

function sendKnowledgeGapAlert(created, pendingCount) {
  const base = config.baseUrl || 'http://localhost:3000';
  const bullets = created.slice(0, 5).map((c) => `• "${c.question}"`).join('\n');
  const more = created.length > 5 ? `\n…and ${created.length - 5} more` : '';
  const md = `🧠 *Bot needs your help!*\n\nThe bot couldn't answer ${created.length} new question(s):\n${bullets}${more}\n\nTeach the right reply here → ${base}/admin/knowledge\n(${pendingCount} question${pendingCount === 1 ? '' : 's'} waiting in total)`;
  const htmlBullets = created.slice(0, 5).map((c) => `• "${c.question}"`).join('<br>');
  const html = `🧠 <b>Bot needs your help!</b><br><br>The bot couldn't answer ${created.length} new question(s):<br>${htmlBullets}<br><br>Teach the reply → ${base}/admin/knowledge`;

  const ownerNumber = config.owner?.whatsappNumber;
  if (ownerNumber && whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
    const cleanOwner = ownerNumber.replace(/[^0-9]/g, '') + '@c.us';
    whatsappWebBot.client.sendMessage(cleanOwner, md).catch((err) =>
      console.error('[Diagnose] Failed to send WhatsApp knowledge-gap alert:', err.message)
    );
  }
  if (config.telegram?.botToken && config.telegram?.chatId) {
    telegramService.sendAlert(html).catch((err) =>
      console.error('[Diagnose] Failed to send Telegram knowledge-gap alert:', err.message)
    );
  }
}

export default { diagnoseUnanswered };

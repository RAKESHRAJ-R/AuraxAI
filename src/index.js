import { serverLogs } from './services/logger.js';
import express from 'express';
import config, { validateConfig } from './config/config.js';
import whatsappWebBot from './services/whatsapp-web-bot.js';
import followUpService from './services/followup.js';
import aiService from './services/ai.js';
import dbService from './services/db.js';
import knowledgeService from './services/knowledge.js';
import { diagnoseUnanswered } from './services/diagnose.js';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIST = path.join(__dirname, '../admin/dist');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Unified admin console (Vite + React SPA, built to admin/dist). Static assets
// are served under /admin; a client-routing fallback (near app.listen) serves
// index.html for deep links like /admin/monitor.
app.use('/admin', express.static(ADMIN_DIST));

// The three former standalone pages are now sections of the one console.
// Redirect the old URLs so any existing bookmarks keep working.
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/apiwork.html', (req, res) => res.redirect('/admin/monitor'));
app.get('/whatsapp-link.html', (req, res) => res.redirect('/admin/whatsapp'));
app.get('/knowledge-hub.html', (req, res) => res.redirect('/admin/knowledge'));

// Run validation check on launch
validateConfig();

/**
 * WhatsApp Web Status Route
 * Used by the pairing web interface to fetch the connection QR code and state.
 */
app.get('/api/whatsapp/status', requireKnowledgeAuth, (req, res) => {
  if (!config.whatsappWeb || !config.whatsappWeb.enabled) {
    return res.status(400).json({ error: 'WhatsApp Web Integration is disabled.' });
  }
  res.json(whatsappWebBot.getStatus());
});

/**
 * Retry Queue Stats Route
 * Shows pending LLM retries (survives restarts via DB persistence).
 * Useful for monitoring quota-exhausted queries waiting to be reprocessed.
 */
/**
 * Provider Analytics Stats Route
 * Shows per-provider usage counters, error rates, quota exhaustion, and active provider.
 * Useful for monitoring which LLM providers are handling the load and detecting issues.
 */
app.get('/api/provider-stats', requireKnowledgeAuth, (req, res) => {
  try {
    const stats = aiService.getProviderStats();
    res.json(stats);
  } catch (err) {
    console.error('[Server] /api/provider-stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch provider stats' });
  }
});

/**
 * Reset Provider Analytics Stats Route
 */
app.post('/api/provider-stats/reset', requireKnowledgeAuth, (req, res) => {
  try {
    aiService.resetProviderStats();
    res.json({ status: 'ok', message: 'Provider analytics stats reset.' });
  } catch (err) {
    console.error('[Server] /api/provider-stats/reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset provider stats' });
  }
});

app.get('/api/retry-stats', requireKnowledgeAuth, async (req, res) => {
  try {
    const allRetries = await dbService.getAllPendingRetries();
    const now = Date.now();

    const stats = {
      total: allRetries.length,
      due: allRetries.filter(r => r.retryAt <= now).length,
      providers: {
        groq: !!config.groq?.apiKey,
        openai: !!config.openai?.apiKey,
        gemini: !!config.gemini?.apiKey,
        activeProvider: aiService.activeProvider || 'none',
      },
      retries: allRetries.map(r => ({
        senderId: r.senderId?.toString().slice(0, 20),
        query: r.userQuery?.toString().slice(0, 60),
        customerName: r.customerName || null,
        retryAt: new Date(r.retryAt).toISOString(),
        isDue: r.retryAt <= now,
        createdAt: r.createdAt || null,
      })),
    };

    res.json(stats);
  } catch (err) {
    console.error('[Server] /api/retry-stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch retry stats' });
  }
});

/**
 * Active Sessions Route
 * Returns a list of all active user sessions for monitoring.
 */
app.get('/api/sessions', requireKnowledgeAuth, async (req, res) => {
  try {
    const sessions = await dbService.getAllSessions();
    const mapped = sessions.map(s => ({
      userId: s.userId,
      state: s.state,
      cart: s.cart || [],
      address: s.address,
      lastActive: s.lastActive,
      requiresEscalation: s.requiresEscalation,
      historyCount: s.history ? s.history.length : 0,
      language: s.language || 'english',
    }));
    // Sort by last active desc
    mapped.sort((a, b) => new Date(b.lastActive || 0) - new Date(a.lastActive || 0));
    res.json(mapped);
  } catch (err) {
    console.error('[Server] /api/sessions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

/**
 * Server Logs Route
 * Serves the rolling console output history for diagnostics.
 */
app.get('/api/logs', requireKnowledgeAuth, (req, res) => {
  try {
    res.json(serverLogs || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch server logs' });
  }
});

/**
 * ── Knowledge Hub ──────────────────────────────────────────────────────────
 * A protected admin page (/knowledge-hub.html) where the store owner teaches the bot
 * corrections/answers without any code change. Single shared-password auth: log in once,
 * get a bearer token (kept in memory — a restart just requires re-login).
 */
const knowledgeTokens = new Set(); // valid session tokens (in-memory)

function requireKnowledgeAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && knowledgeTokens.has(token)) return next();
  return res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

// Flag likely-problem conversations (same heuristics as `npm run review`) so the client
// can correct real mistakes from the UI. Kept inline to reuse dbService directly.
const KNOWLEDGE_FALLBACK_PATTERNS = [
  /sorry,?\s*i couldn't process that/i,
  /undergoing maintenance/i,
  /getting (a lot of|tons of) messages/i,
  /could you tell me again what you're looking for/i,
  /couldn't find that exact jersey/i,
  /trouble (processing|understanding)/i,
];
function normalizeMsg(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

app.post('/api/knowledge-hub/login', (req, res) => {
  const configured = config.knowledgeHub?.password;
  if (!configured) {
    return res.status(503).json({ error: 'Knowledge Hub is not configured. Set KNOWLEDGE_HUB_PASSWORD.' });
  }
  const supplied = (req.body?.password || '').toString();
  // constant-time compare to avoid leaking the password length/prefix via timing
  const a = Buffer.from(supplied);
  const b = Buffer.from(configured);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
  const token = crypto.randomBytes(24).toString('hex');
  knowledgeTokens.add(token);
  res.json({ token });
});

app.get('/api/knowledge', requireKnowledgeAuth, async (req, res) => {
  try {
    // Hide dismissed auto-draft tombstones — they're kept only to stop re-diagnosis.
    const all = await dbService.getAllKnowledge();
    res.json(all.filter(k => !k.dismissed));
  } catch (err) {
    console.error('[Server] GET /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to load knowledge entries' });
  }
});

// Permanently dismiss an auto-drafted question so it never gets re-queued.
app.post('/api/knowledge/:id/dismiss', requireKnowledgeAuth, async (req, res) => {
  try {
    await dbService.dismissKnowledge(req.params.id);
    knowledgeService.invalidate();
    res.json({ ok: true });
  } catch (err) {
    console.error('[Server] POST /api/knowledge/:id/dismiss error:', err.message);
    res.status(500).json({ error: 'Failed to dismiss question' });
  }
});

app.post('/api/knowledge', requireKnowledgeAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.answer || !String(body.answer).trim()) {
      return res.status(400).json({ error: 'An answer is required.' });
    }
    // Accept keywords as an array or a comma-separated string.
    let keywords = body.keywords;
    if (typeof keywords === 'string') keywords = keywords.split(',').map(k => k.trim()).filter(Boolean);
    const saved = await dbService.saveKnowledge({ ...body, keywords });
    knowledgeService.invalidate(); // edits go live immediately, no restart
    res.json(saved);
  } catch (err) {
    console.error('[Server] POST /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to save knowledge entry' });
  }
});

app.delete('/api/knowledge/:id', requireKnowledgeAuth, async (req, res) => {
  try {
    await dbService.deleteKnowledge(req.params.id);
    knowledgeService.invalidate();
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Server] DELETE /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to delete knowledge entry' });
  }
});

// Badge count for the Knowledge Hub nav — how many auto-drafted questions still
// need an answer from the owner.
app.get('/api/knowledge/pending-count', requireKnowledgeAuth, async (req, res) => {
  try {
    res.json({ count: await dbService.countPendingKnowledge() });
  } catch (err) {
    console.error('[Server] GET /api/knowledge/pending-count error:', err.message);
    res.status(500).json({ error: 'Failed to count pending knowledge' });
  }
});

// Run the unanswered-question diagnosis on demand (also runs on a schedule). Creates
// "needs answer" drafts from struggling conversations; returns how many are waiting.
// alert:false here — the on-demand refresh from the dashboard shouldn't ping the owner
// (the periodic scheduler is what alerts on genuinely new gaps).
app.post('/api/knowledge/diagnose', requireKnowledgeAuth, async (req, res) => {
  try {
    const result = await diagnoseUnanswered({ alert: false });
    res.json(result);
  } catch (err) {
    console.error('[Server] POST /api/knowledge/diagnose error:', err.message);
    res.status(500).json({ error: 'Failed to run diagnosis' });
  }
});

app.get('/api/knowledge/review', requireKnowledgeAuth, async (req, res) => {
  try {
    const leads = await dbService.getAllLeads();
    const flagged = [];
    for (const lead of leads) {
      const conversation = lead.conversation || [];
      if (conversation.length === 0) continue;
      const reasons = [];

      const fallbackHits = conversation
        .filter(m => m.role === 'assistant')
        .filter(m => KNOWLEDGE_FALLBACK_PATTERNS.some(re => re.test(m.content || '')));
      if (fallbackHits.length > 0) reasons.push(`fallback/error reply (${fallbackHits.length}x)`);

      const userMsgs = conversation.filter(m => m.role === 'user').map(m => normalizeMsg(m.content));
      const counts = {};
      for (const m of userMsgs) { if (m.length >= 4) counts[m] = (counts[m] || 0) + 1; }
      const repeated = Object.entries(counts).filter(([, c]) => c >= 2);
      if (repeated.length > 0) reasons.push(`customer repeated a question (${repeated.length})`);

      if (lead.status !== 'completed' && ((lead.cart && lead.cart.length > 0) || lead.address)) {
        reasons.push('abandoned mid-purchase');
      }

      if (reasons.length > 0) {
        flagged.push({
          id: lead.id || lead.userId,
          name: lead.name || 'Unknown',
          phone: lead.phone || lead.userId,
          status: lead.status,
          updatedAt: lead.updatedAt,
          reasons,
          lastTurns: conversation.slice(-6).map(m => ({ role: m.role, content: (m.content || '').slice(0, 300) })),
        });
      }
    }
    flagged.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    res.json({ total: leads.length, flaggedCount: flagged.length, flagged });
  } catch (err) {
    console.error('[Server] GET /api/knowledge/review error:', err.message);
    res.status(500).json({ error: 'Failed to build review list' });
  }
});

// Client-side routing fallback for the admin SPA — any /admin/* deep link that
// isn't a real static asset returns index.html so react-router can handle it.
// Declared last so real /admin static assets and all /api routes match first.
app.get('/admin/*', (req, res) => res.sendFile(path.join(ADMIN_DIST, 'index.html')));

// Start Server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 Theaurax AI Sales Assistant is listening on port ${PORT}`);
  console.log(`🛠️  Admin console (single app):  GET http://localhost:${PORT}/admin`);
  console.log(`     ├─ Monitor        /admin/monitor`);
  console.log(`     ├─ WhatsApp link  /admin/whatsapp`);
  console.log(`     └─ Knowledge Hub  /admin/knowledge   (sign in with KNOWLEDGE_HUB_PASSWORD)`);

  // Initialize WhatsApp Web Bot if enabled in configuration
  if (config.whatsappWeb && config.whatsappWeb.enabled) {
    whatsappWebBot.initialize();
  }

  // Start cold lead follow-up scheduler
  followUpService.start();

  // Process any pending retries from previous server sessions (quota-exhausted queries)
  // This runs after a brief delay to ensure WhatsApp is connected and DB is initialized.
  setTimeout(() => {
    aiService.processPendingRetries().catch(err => {
      console.error('[Server] Error processing pending retries:', err.message);
    });
  }, 15000);

  // Periodic check for pending retries (every 60 seconds)
  setInterval(() => {
    aiService.processPendingRetries().catch(err => {
      console.error('[Server] Periodic retry check error:', err.message);
    });
  }, 60000);

  // Unanswered-question diagnosis: scan conversations for gaps the bot couldn't handle,
  // queue "needs answer" drafts in the Knowledge Hub, and alert the owner on new ones.
  // Once ~20s after boot, then every 30 minutes.
  setTimeout(() => {
    diagnoseUnanswered({ alert: true })
      .then(r => r.created && console.log(`[Diagnose] Queued ${r.created} new unanswered question(s); ${r.pendingCount} waiting.`))
      .catch(err => console.error('[Server] Initial diagnosis error:', err.message));
  }, 20000);
  setInterval(() => {
    diagnoseUnanswered({ alert: true })
      .then(r => r.created && console.log(`[Diagnose] Queued ${r.created} new unanswered question(s); ${r.pendingCount} waiting.`))
      .catch(err => console.error('[Server] Periodic diagnosis error:', err.message));
  }, 30 * 60 * 1000);
});

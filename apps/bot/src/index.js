import { serverLogs } from './services/logger.js';
import express from 'express';
import config, { validateConfig } from './config/config.js';
import whatsappWebBot from './services/whatsapp-web-bot.js';
import woocommerceService from './services/woocommerce.js';
import followUpService from './services/followup.js';
import aiService from './services/ai.js';
import dbService from './services/db.js';
import knowledgeService from './services/knowledge.js';
import retrievalService from './services/retrieval.js';
import textExtractService from './services/textextract.js';
import embeddingService from './services/embeddings.js';
import { diagnoseUnanswered } from './services/diagnose.js';
import adminAuth, { requirePermission } from './services/adminAuth.js';
import { createAdminRouter } from './routes/admin.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The self-hosted build of the admin console (apps/admin, built with base '/admin/').
// The Vercel deploy uses apps/admin/dist instead — different base, so the two outputs
// are not interchangeable. Missing dist-express is fine: /admin just 404s and the
// Vercel-hosted console remains the way in.
const ADMIN_DIST = path.join(__dirname, '../../admin/dist-express');

const app = express();

/**
 * CORS for the admin console.
 *
 * The console's primary home is Vercel, which is a different origin than this server,
 * so its API calls are cross-origin and the browser will discard every response unless
 * we opt in explicitly. Configured via ADMIN_ALLOWED_ORIGINS.
 *
 * Deliberately NOT a wildcard `*`: these endpoints expose sessions, logs and customer
 * conversations. An entry may be an exact origin (`https://admin.theaurax.in`) or a
 * `*.`-prefixed suffix (`*.vercel.app`) so Vercel's per-branch preview deploys, whose
 * hostnames are generated per commit and cannot be enumerated ahead of time, still work.
 *
 * No `Access-Control-Allow-Credentials` — auth is a bearer token in a header, not a
 * cookie, so the browser never needs to attach credentials to these requests.
 */
function originAllowed(origin) {
  return config.adminAllowedOrigins.some((allowed) =>
    allowed.startsWith('*.')
      ? origin.endsWith(allowed.slice(1)) // '*.vercel.app' → any host ending '.vercel.app'
      : origin === allowed
  );
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  // The response body varies by Origin, so caches must key on it. Set unconditionally:
  // omitting it on rejected origins lets a shared cache serve an allowed origin's
  // response (with its Allow-Origin header) to a disallowed one.
  res.setHeader('Vary', 'Origin');

  // Preflight is answered here rather than falling through to the route, because
  // OPTIONS carries no Authorization header and requirePermission would 401 it.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.json());
app.use(express.static('public'));

// Admin console sign-in, users, roles and activity log (/api/auth/*, /api/admin/*).
app.use('/api', createAdminRouter());

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
app.get('/api/whatsapp/status', requirePermission('whatsapp.view'), (req, res) => {
  if (!config.whatsappWeb || !config.whatsappWeb.enabled) {
    return res.status(400).json({ error: 'WhatsApp Web Integration is disabled.' });
  }
  const status = whatsappWebBot.getStatus();
  // The QR and the phone-linking code ARE the keys to the bot's number: whoever scans or
  // types them links their own phone. View-only roles see the state, never the codes.
  if (!req.admin.can('whatsapp.manage')) {
    res.json({ ...status, qrDataUrl: null, pairingCode: null, codesHidden: true });
    return;
  }
  res.json(status);
});

/**
 * WhatsApp Web Logout Route
 * Unlinks the currently paired phone and brings a fresh QR up, so the admin can move the
 * bot to a different number without needing physical access to the device it's paired to.
 */
app.post('/api/whatsapp/logout', requirePermission('whatsapp.manage'), async (req, res) => {
  if (!config.whatsappWeb || !config.whatsappWeb.enabled) {
    return res.status(400).json({ error: 'WhatsApp Web Integration is disabled.' });
  }
  try {
    const result = await whatsappWebBot.logout();
    if (!result.ok) return res.status(409).json({ error: result.message });
    await adminAuth.record(req, 'whatsapp.logout',
      `Logged out the bot's WhatsApp number${result.previousNumber ? ` (+${result.previousNumber})` : ''}`);
    res.json(result);
  } catch (err) {
    console.error('[API] WhatsApp logout failed:', err.message);
    res.status(500).json({ error: 'Logout failed. Check the server logs.' });
  }
});

/**
 * WhatsApp phone-number linking — the alternative to scanning the QR. The admin enters the
 * number, the bot shows an 8-character code, and it is typed into the phone under
 * Linked devices → Link a device → "Link with phone number instead".
 */
app.post('/api/whatsapp/pair', requirePermission('whatsapp.manage'), async (req, res) => {
  if (!config.whatsappWeb || !config.whatsappWeb.enabled) {
    return res.status(400).json({ error: 'WhatsApp Web Integration is disabled.' });
  }
  try {
    const result = await whatsappWebBot.startPhonePairing(req.body?.phoneNumber);
    if (!result.ok) return res.status(400).json({ error: result.message });
    await adminAuth.record(req, 'whatsapp.pair', `Started linking WhatsApp by phone number (+${result.phoneNumber})`);
    res.json(result);
  } catch (err) {
    console.error('[API] WhatsApp phone pairing failed:', err.message);
    res.status(500).json({ error: 'Could not start phone-number linking. Check the server logs.' });
  }
});

app.post('/api/whatsapp/pair/cancel', requirePermission('whatsapp.manage'), async (req, res) => {
  if (!config.whatsappWeb || !config.whatsappWeb.enabled) {
    return res.status(400).json({ error: 'WhatsApp Web Integration is disabled.' });
  }
  try {
    const result = await whatsappWebBot.cancelPhonePairing();
    if (!result.ok) return res.status(409).json({ error: result.message });
    await adminAuth.record(req, 'whatsapp.pair_cancel', 'Switched WhatsApp linking back to the QR code');
    res.json(result);
  } catch (err) {
    console.error('[API] WhatsApp pairing cancel failed:', err.message);
    res.status(500).json({ error: 'Could not switch back to QR. Check the server logs.' });
  }
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
app.get('/api/provider-stats', requirePermission('monitor.view'), (req, res) => {
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
// Owner-only: no console page exposes it, so no role can be granted it.
app.post('/api/provider-stats/reset', requirePermission('owner'), (req, res) => {
  try {
    aiService.resetProviderStats();
    adminAuth.record(req, 'monitor.reset', 'Reset the provider statistics');
    res.json({ status: 'ok', message: 'Provider analytics stats reset.' });
  } catch (err) {
    console.error('[Server] /api/provider-stats/reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset provider stats' });
  }
});

app.get('/api/retry-stats', requirePermission('monitor.view'), async (req, res) => {
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
app.get('/api/sessions', requirePermission('monitor.view'), async (req, res) => {
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
 * Support Tickets Route
 * After-sales tickets raised by the support agent (complaints, returns, tracking issues).
 */
app.get('/api/tickets', requirePermission('tickets.view'), async (req, res) => {
  try {
    res.json(await dbService.getAllTickets());
  } catch (err) {
    console.error('[Server] /api/tickets error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Open-ticket count for the admin sidebar badge (cheap poll).
app.get('/api/tickets/open-count', requirePermission('tickets.view'), async (req, res) => {
  try {
    const tickets = await dbService.getAllTickets();
    res.json({ count: tickets.filter(t => (t.status || 'open') === 'open').length });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// Update a ticket's status (open / resolved) from the admin console.
app.post('/api/tickets/:id/status', requirePermission('tickets.manage'), async (req, res) => {
  try {
    await dbService.updateTicketStatus(req.params.id, req.body?.status);
    await adminAuth.record(req, 'tickets.status',
      `${req.body?.status === 'resolved' ? 'Resolved' : 'Reopened'} ticket ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Server] POST /api/tickets/:id/status error:', err.message);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

/**
 * Server Logs Route
 * Serves the rolling console output history for diagnostics.
 */
app.get('/api/logs', requirePermission('monitor.view'), (req, res) => {
  try {
    res.json(serverLogs || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch server logs' });
  }
});

/**
 * ── Knowledge Hub ──────────────────────────────────────────────────────────
 * The admin console section where the store owner teaches the bot corrections/answers
 * without any code change. Sign-in, users and roles live in routes/admin.js.
 */

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

app.get('/api/knowledge', requirePermission('knowledge.view'), async (req, res) => {
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
app.post('/api/knowledge/:id/dismiss', requirePermission('knowledge.edit'), async (req, res) => {
  try {
    const entry = (await dbService.getAllKnowledge()).find(k => k.id === req.params.id);
    await dbService.dismissKnowledge(req.params.id);
    knowledgeService.invalidate();
    await adminAuth.record(req, 'knowledge.dismiss', `Dismissed the unanswered question "${entry?.question || req.params.id}"`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Server] POST /api/knowledge/:id/dismiss error:', err.message);
    res.status(500).json({ error: 'Failed to dismiss question' });
  }
});

app.post('/api/knowledge', requirePermission('knowledge.edit'), async (req, res) => {
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
    await adminAuth.record(req, 'knowledge.save',
      `${body.id ? 'Edited' : 'Added'} the answer for "${saved.question || saved.answer.slice(0, 60)}"${saved.active ? '' : ' (inactive)'}`);
    res.json(saved);
  } catch (err) {
    console.error('[Server] POST /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to save knowledge entry' });
  }
});

app.delete('/api/knowledge/:id', requirePermission('knowledge.edit'), async (req, res) => {
  try {
    const entry = (await dbService.getAllKnowledge()).find(k => k.id === req.params.id);
    await dbService.deleteKnowledge(req.params.id);
    knowledgeService.invalidate();
    await adminAuth.record(req, 'knowledge.delete', `Deleted the answer for "${entry?.question || req.params.id}"`);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Server] DELETE /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to delete knowledge entry' });
  }
});

// Badge count for the Knowledge Hub nav — how many auto-drafted questions still
// need an answer from the owner.
app.get('/api/knowledge/pending-count', requirePermission('knowledge.view'), async (req, res) => {
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
app.post('/api/knowledge/diagnose', requirePermission('knowledge.edit'), async (req, res) => {
  try {
    const result = await diagnoseUnanswered({ alert: false });
    res.json(result);
  } catch (err) {
    console.error('[Server] POST /api/knowledge/diagnose error:', err.message);
    res.status(500).json({ error: 'Failed to run diagnosis' });
  }
});

/**
 * ── Knowledge SOURCES (documents + websites) ───────────────────────────────
 * The Q&A endpoints above cover hand-written answers. These cover the other two
 * knowledge-source types: uploaded files and crawled web pages. Both are extracted
 * to text, chunked, embedded (when an embedding key is available) and retrieved at
 * answer time by retrievalService.
 *
 * Uploads are held in memory, never written to disk — the extracted text is what we
 * keep, and a stray uploads/ directory on the server is just an attack surface.
 */
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (textExtractService.isSupported(file.originalname)) return cb(null, true);
    cb(new Error(`Unsupported file type. Supported: ${textExtractService.supportedExtensions.join(', ')}`));
  },
});

app.get('/api/knowledge/sources', requirePermission('knowledge.view'), async (req, res) => {
  try {
    const [sources, usage] = await Promise.all([
      dbService.getAllKnowledgeSources(),
      dbService.getKnowledgeStorageUsage(),
    ]);
    res.json({
      sources,
      usage,
      // Surfaced in the UI so the owner knows whether they're getting semantic search
      // or the keyword-only fallback — otherwise a silent downgrade looks like a bug.
      embeddings: {
        enabled: embeddingService.isEnabled(),
        provider: embeddingService.provider,
        model: embeddingService.model,
        dimensions: embeddingService.dimensions,
        lastError: embeddingService.disabledReason,
      },
    });
  } catch (err) {
    console.error('[Server] GET /api/knowledge/sources error:', err.message);
    res.status(500).json({ error: 'Failed to load knowledge sources' });
  }
});

app.post('/api/knowledge/sources/document', requirePermission('knowledge.sources'), (req, res) => {
  uploadDocument.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      const result = await retrievalService.indexDocument(req.file.buffer, req.file.originalname, {
        language: req.body?.language,
        title: req.body?.title,
      });
      console.log(`[Server] Indexed document "${result.source.title}" — ${result.chunks} chunks, embedded=${result.embedded}`);
      await adminAuth.record(req, 'sources.document', `Uploaded the document "${result.source.title}" (${result.chunks} chunks)`);
      res.json(result);
    } catch (err) {
      // Extraction failures are almost always the owner's file being unreadable
      // (scanned PDF, empty doc), not a server bug — report it as a 400 with the
      // actual reason so they can fix it themselves.
      console.warn('[Server] Document indexing failed:', err.message);
      res.status(400).json({ error: err.message });
    }
  });
});

app.post('/api/knowledge/sources/website', requirePermission('knowledge.sources'), async (req, res) => {
  const { url, maxPages, maxDepth, language, title } = req.body || {};
  if (!url) return res.status(400).json({ error: 'A website URL is required.' });
  try {
    const result = await retrievalService.indexWebsite(url, {
      language,
      title,
      maxPages: Number(maxPages) || undefined,
      maxDepth: Number(maxDepth) >= 0 ? Number(maxDepth) : undefined,
    });
    console.log(`[Server] Indexed website "${result.source.title}" — ${result.pagesCrawled} pages, ${result.chunks} chunks`);
    await adminAuth.record(req, 'sources.website', `Crawled ${url} (${result.pagesCrawled} pages, ${result.chunks} chunks)`);
    res.json(result);
  } catch (err) {
    console.warn('[Server] Website indexing failed:', err.message);
    res.status(400).json({ error: err.message, blocked: err.blocked === true });
  }
});

app.post('/api/knowledge/sources/:id/toggle', requirePermission('knowledge.sources'), async (req, res) => {
  try {
    const all = await dbService.getAllKnowledgeSources();
    const existing = all.find(s => s.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Source not found' });
    const saved = await dbService.saveKnowledgeSource({ ...existing, active: !existing.active });
    retrievalService.invalidate();
    await adminAuth.record(req, 'sources.toggle', `Turned ${saved.active ? 'on' : 'off'} the source "${saved.title}"`);
    res.json(saved);
  } catch (err) {
    console.error('[Server] POST /api/knowledge/sources/:id/toggle error:', err.message);
    res.status(500).json({ error: 'Failed to update source' });
  }
});

app.delete('/api/knowledge/sources/:id', requirePermission('knowledge.sources'), async (req, res) => {
  try {
    const source = (await dbService.getAllKnowledgeSources()).find(s => s.id === req.params.id);
    await dbService.deleteKnowledgeSource(req.params.id);
    retrievalService.invalidate();
    await adminAuth.record(req, 'sources.delete', `Deleted the source "${source?.title || req.params.id}"`);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Server] DELETE /api/knowledge/sources/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

app.get('/api/knowledge/review', requirePermission('knowledge.view'), async (req, res) => {
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

// Settle the storage backend BEFORE accepting traffic. dbService retries MongoDB with
// backoff; without this await, requests arriving during those retries would be served
// from JSON and then be invisible once Mongo came up.
await dbService.ready;
// Built-in roles + the first Owner account (from ADMIN_OWNER_EMAIL) before anyone can sign in.
await adminAuth.ensureSeeded().catch(err => console.error('[Admin Auth] Setup failed — console sign-in may not work:', err.message));

app.listen(PORT, () => {
  console.log(`🚀 Theaurax AI Sales Assistant is listening on port ${PORT}`);
  console.log(`🛠️  Admin console (single app):  GET http://localhost:${PORT}/admin`);
  console.log(`     ├─ Monitor        /admin/monitor`);
  console.log(`     ├─ WhatsApp link  /admin/whatsapp`);
  console.log(`     ├─ Knowledge Hub  /admin/knowledge`);
  console.log(`     └─ Users & Roles  /admin/users       (each person signs in with their own email + password)`);

  // Expired console sign-ins are rejected on use anyway; this just keeps the store small.
  setInterval(() => {
    dbService.purgeExpiredAdminSessions()
      .catch(err => console.error('[Admin Auth] Session cleanup failed:', err.message));
  }, 6 * 60 * 60 * 1000);

  // Initialize WhatsApp Web Bot if enabled in configuration
  if (config.whatsappWeb && config.whatsappWeb.enabled) {
    whatsappWebBot.initialize();
  }

  // Keep the local product cache fresh WITHOUT any manual `npm run sync`, so products the
  // client adds/edits in WooCommerce become searchable automatically. This ONLY calls the
  // store's own WooCommerce REST API — zero LLM tokens, no paid-AI quota. Sync once shortly
  // after boot (delayed so startup isn't blocked), then every 30 minutes. Failures are
  // non-fatal: the bot keeps serving the last good cache.
  const PRODUCT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
  const runProductSync = () =>
    woocommerceService.syncAndCacheProducts()
      .then(list => console.log(`[Product Sync] Cache refreshed — ${list.length} products.`))
      .catch(err => console.error('[Product Sync] Failed (keeping last cache):', err.message));
  setTimeout(runProductSync, 8000);
  setInterval(runProductSync, PRODUCT_SYNC_INTERVAL_MS);

  // Can we create orders at all? Probe at boot and every 15 minutes. While the answer is no,
  // the agent hands checkout to a human instead of walking customers into a dead end. This is
  // the check that would have surfaced the 2026-08-07 REST block on the day it started
  // instead of six weeks later, after every order in between had silently failed.
  const ORDERING_HEALTH_INTERVAL_MS = 15 * 60 * 1000;
  setTimeout(() => { woocommerceService.checkOrderingHealth(); }, 6000);
  setInterval(() => { woocommerceService.checkOrderingHealth({ quiet: true }); }, ORDERING_HEALTH_INTERVAL_MS);

  // Preload the local embedding model so the first customer question after a restart
  // doesn't pay the model-load latency inside its own reply. Only worth doing when
  // there is something indexed to search — with no knowledge sources the retrieval
  // path never embeds anything, and loading the model would just cost ~130 MB of RSS
  // for nothing. Delayed past the WhatsApp/Chromium startup spike.
  if (config.embeddings?.warmup) {
    setTimeout(() => {
      retrievalService.hasSources()
        .then(has => has && embeddingService.warmup())
        .catch(err => console.warn('[Embeddings] Warmup skipped:', err.message));
    }, 25000);
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

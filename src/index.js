import express from 'express';
import config, { validateConfig } from './config/config.js';
import whatsappWebBot from './services/whatsapp-web-bot.js';
import followUpService from './services/followup.js';
import aiService from './services/ai.js';
import dbService from './services/db.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Run validation check on launch
validateConfig();

/**
 * WhatsApp Web Status Route
 * Used by the pairing web interface to fetch the connection QR code and state.
 */
app.get('/api/whatsapp/status', (req, res) => {
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
app.get('/api/provider-stats', (req, res) => {
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
app.post('/api/provider-stats/reset', (req, res) => {
  try {
    aiService.resetProviderStats();
    res.json({ status: 'ok', message: 'Provider analytics stats reset.' });
  } catch (err) {
    console.error('[Server] /api/provider-stats/reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset provider stats' });
  }
});

app.get('/api/retry-stats', async (req, res) => {
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
app.get('/api/sessions', async (req, res) => {
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

// Start Server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 Theaurax AI Sales Assistant is listening on port ${PORT}`);
  console.log(`🔗 WhatsApp Web Link page:      GET http://localhost:${PORT}/whatsapp-link.html`);

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
});

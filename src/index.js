import express from 'express';
import config, { validateConfig } from './config/config.js';
import whatsappWebBot from './services/whatsapp-web-bot.js';

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

// Start Server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 Theaurax AI Sales Assistant is listening on port ${PORT}`);
  console.log(`🔗 WhatsApp Web Link page:      GET http://localhost:${PORT}/whatsapp-link.html`);

  // Initialize WhatsApp Web Bot if enabled in configuration
  if (config.whatsappWeb && config.whatsappWeb.enabled) {
    whatsappWebBot.initialize();
  }
});

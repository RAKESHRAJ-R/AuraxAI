import whatsappWebBot from './services/whatsapp-web-bot.js';
import config from './config/config.js';

console.log('Testing WhatsApp Web Bot Module Resolution...');
console.log('Configuration status:');
console.log(' - Enabled:', config.whatsappWeb.enabled);

try {
  const status = whatsappWebBot.getStatus();
  console.log(' - Current Bot Status:', status);
  console.log('✅ Module resolved and initialized successfully!');
} catch (err) {
  console.error('❌ Error resolving module:', err);
}

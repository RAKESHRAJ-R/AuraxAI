import express from 'express';
import config, { validateConfig } from './config/config.js';
import aiService from './services/ai.js';
import instagramService from './services/instagram.js';
import whatsappService from './services/whatsapp.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Run validation check on launch
validateConfig();

/**
 * 1. Webhook Verification (GET /webhook)
 * Meta calls this to verify the authenticity of our server setup.
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Match against our configured secret token
  const expectedVerifyToken = config.instagram.verifyToken;

  if (mode && token) {
    if (mode === 'subscribe' && token === expectedVerifyToken) {
      console.log('[Webhook Verification] Success! Verified by Meta Graph API.');
      return res.status(200).send(challenge);
    } else {
      console.warn('[Webhook Verification] Failed. Tokens did not match.');
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

/**
 * 2. Webhook Event Handler (POST /webhook)
 * Receives real-time customer DMs (Instagram + WhatsApp) and replies using the AI Agent.
 */
app.post('/webhook', (req, res) => {
  const body = req.body;

  // Verify Instagram event
  if (body.object === 'instagram') {
    // Respond to Meta immediately to prevent request timeouts and duplicate retries
    res.status(200).send('EVENT_RECEIVED');

    body.entry.forEach((entry) => {
      if (!entry.messaging) return;

      entry.messaging.forEach(async (messagingEvent) => {
        const senderId = messagingEvent.sender?.id;
        const messageText = messagingEvent.message?.text;

        // Skip if message doesn't contain text, is a delivery/read receipt, or is an echo
        if (!messageText || messagingEvent.message.is_echo) {
          return;
        }

        console.log(`\n📬 [New Instagram Message Received] from IGSID: ${senderId}`);
        console.log(`   Content: "${messageText}"`);

        try {
          // Process query using AI Sales Agent (stateful)
          const agentResponse = await aiService.answerQuery(senderId, messageText);
          
          console.log(`🧠 [Instagram Agent Reasoning]`);
          console.log(`   Intent:     ${agentResponse.intent.toUpperCase()}`);
          console.log(`   Escalate:   ${agentResponse.requiresEscalation}`);
          console.log(`   Matches:    ${agentResponse.suggestedProductIds.length} products`);

          // Reply back to customer
          await instagramService.sendTextMessage(senderId, agentResponse.replyText);

        } catch (error) {
          console.error(`❌ [Webhook Handler] Error processing Instagram message from IGSID ${senderId}:`, error.message);
        }
      });
    });
  } 
  // Verify WhatsApp event
  else if (body.object === 'whatsapp_business_account') {
    res.status(200).send('EVENT_RECEIVED');

    body.entry?.forEach((entry) => {
      entry.changes?.forEach((change) => {
        const value = change.value;
        if (value?.messaging_product !== 'whatsapp' || !value.messages) return;

        value.messages.forEach(async (message) => {
          const senderId = message.from; // Sender mobile number
          const messageText = message.text?.body;
          const isStatus = message.type !== 'text';

          if (!messageText || isStatus) return;

          console.log(`\n📬 [New WhatsApp Message Received] from Mobile: ${senderId}`);
          console.log(`   Content: "${messageText}"`);

          try {
            // Process query using AI Sales Agent (stateful)
            const agentResponse = await aiService.answerQuery(senderId, messageText);
            
            console.log(`🧠 [WhatsApp Agent Reasoning]`);
            console.log(`   Intent:     ${agentResponse.intent.toUpperCase()}`);
            console.log(`   Escalate:   ${agentResponse.requiresEscalation}`);
            console.log(`   Matches:    ${agentResponse.suggestedProductIds.length} products`);

            // Reply back to customer
            await whatsappService.sendTextMessage(senderId, agentResponse.replyText);

          } catch (error) {
            console.error(`❌ [Webhook Handler] Error processing WhatsApp message from ${senderId}:`, error.message);
          }
        });
      });
    });
  } else {
    // Not an Instagram or WhatsApp event
    res.sendStatus(404);
  }
});



// Start Server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 Theaurax AI Sales Assistant is listening on port ${PORT}`);
  console.log(`🔗 Webhook verification route: GET http://localhost:${PORT}/webhook`);
  console.log(`📬 Webhook messaging route:    POST http://localhost:${PORT}/webhook`);
});

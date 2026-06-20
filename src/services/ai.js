import { OpenAI } from 'openai';
import axios from 'axios';
import config from '../config/config.js';
import faqService from './faq.js';
import woocommerceService from './woocommerce.js';
import dbService from './db.js';
import { generateInvoicePDF } from './invoice.js';
import whatsappService from './whatsapp.js';
import instagramService from './instagram.js';

class AIService {
  constructor() {
    this.openaiApiKey = config.openai.apiKey;
    this.geminiApiKey = config.gemini.apiKey;
    
    // Setup OpenAI if key is valid
    const isOpenaiValid = this.openaiApiKey && !this.openaiApiKey.includes('your_openai') && !this.openaiApiKey.startsWith('sk-proj-k6hqxXOGCd');
    if (isOpenaiValid) {
      this.openai = new OpenAI({ apiKey: this.openaiApiKey });
      console.log('[AI Service] OpenAI Client initialized successfully.');
    } else {
      this.openai = null;
    }

    // Setup Gemini
    if (this.geminiApiKey) {
      console.log('[AI Service] Gemini Client initialized successfully.');
    } else {
      console.log('[AI Service] No Gemini API key provided.');
    }

    if (!this.openai && !this.geminiApiKey) {
      console.log('[AI Service] Running in complete Fallback MOCK Mode.');
    }
  }

  /**
   * Main query handler. Loads user state, runs LLM (or fallback state engine), and saves updated state.
   */
  async answerQuery(senderId, userQuery) {
    // 1. Fetch current session for the user
    const session = await dbService.getSession(senderId);

    // 2. Query local products and FAQs for context matching
    const matchedProducts = woocommerceService.searchProducts(userQuery);
    const matchedFAQs = faqService.searchFAQs(userQuery);
    
    // Skip bulk order checking when user is inputting shipping address
    const isBulkIntent = session.state === 'COLLECTING_ADDRESS' ? false : this.checkBulkIntent(userQuery);

    let result = null;

    // 3. Try OpenAI if configured
    if (this.openai) {
      try {
        result = await this.callOpenAI(session, userQuery, matchedProducts, matchedFAQs);
      } catch (err) {
        console.error('[AI Service] OpenAI error, attempting Gemini fallback...', err.message);
      }
    }

    // 4. Try Gemini if OpenAI is not configured or failed
    if (!result && this.geminiApiKey) {
      try {
        result = await this.callGemini(session, userQuery, matchedProducts, matchedFAQs);
      } catch (err) {
        console.error('[AI Service] Gemini error, attempting rule-based fallback...', err.message);
      }
    }

    // 5. Run rule-based fallback if no LLM responded
    if (!result) {
      result = this.processFallbackStateFlow(session, userQuery, matchedProducts, matchedFAQs, isBulkIntent);
    }

    // 6. Update and save the user's session state
    if (result.sessionUpdate) {
      // Check if transitioning from CONFIRMING_ORDER to IDLE, indicating order confirmed!
      const isConfirmed = session.state === 'CONFIRMING_ORDER' && result.sessionUpdate.state === 'IDLE' && session.cart.length > 0;
      
      if (isConfirmed) {
        try {
          const orderId = `order_${Date.now()}_${senderId.toString().substring(0, 4)}`;
          const invoicePath = await generateInvoicePDF(orderId, {
            userId: senderId,
            customerName: `Customer (${senderId})`,
            cart: session.cart,
            address: session.address
          });
          console.log(`[AI Service] Dynamic PDF proforma invoice created at: ${invoicePath}`);
          result.replyText += `\n\n📄 *Proforma Invoice Generated*:\nDownload here: http://localhost:3000/invoices/invoice_${orderId}.pdf`;
        } catch (invoiceErr) {
          console.error('[AI Service] Proforma invoice PDF generation failed:', invoiceErr.message);
        }
      }

      Object.assign(session, result.sessionUpdate);
    }
    
    // Mark if escalation was flagged and alert owner if not already escalated
    if (result.requiresEscalation && !session.requiresEscalation) {
      session.requiresEscalation = true;
      
      const isSim = senderId.toString().includes('sim') || senderId.toString().includes('test');
      const channel = isSim ? 'Test Simulation' : 'Live Chat';
      const alertMsg = `🚨 *New Wholesale Lead Alert!* 🚨\n\nChannel: *${channel}*\nCustomer ID: *${senderId}*\nQuery: "${userQuery}"\n\nPlease step in to negotiate!`;

      // 1. Send WhatsApp Alert
      const ownerNumber = config.owner.whatsappNumber;
      if (ownerNumber) {
        whatsappService.sendTextMessage(ownerNumber, alertMsg).catch(err => {
          console.error('[AI Service] Failed to send WhatsApp owner escalation alert:', err.message);
        });
      }

      // 2. Send Instagram DM Alert
      const ownerInstagramId = config.owner.instagramId;
      if (ownerInstagramId) {
        instagramService.sendTextMessage(ownerInstagramId, alertMsg).catch(err => {
          console.error('[AI Service] Failed to send Instagram owner escalation alert:', err.message);
        });
      }
    }

    await dbService.saveSession(senderId, session);

    // Save lead details (save active cart/address if not cleared, or track overall status)
    if (session.cart && session.cart.length > 0) {
      await dbService.saveLead({
        userId: senderId,
        cart: session.cart,
        address: session.address,
        requiresEscalation: session.requiresEscalation,
        status: session.state === 'IDLE' ? 'completed' : 'checkout'
      });
    }

    return {
      replyText: result.replyText,
      intent: result.intent || 'other',
      requiresEscalation: result.requiresEscalation || false,
      suggestedProductIds: result.suggestedProductIds || []
    };
  }

  /**
   * Call OpenAI API
   */
  async callOpenAI(session, userQuery, matchedProducts, matchedFAQs) {
    const systemPrompt = this.generateSystemPrompt(session, matchedProducts, matchedFAQs);
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery }
      ],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(completion.choices[0].message.content);
  }

  /**
   * Call Gemini API (2.5 Flash) via direct Axios JSON REST request
   */
  async callGemini(session, userQuery, matchedProducts, matchedFAQs) {
    const systemPrompt = this.generateSystemPrompt(session, matchedProducts, matchedFAQs);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`;
    
    const response = await axios.post(url, {
      contents: [
        {
          role: 'user',
          parts: [{ text: userQuery }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json'
      },
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      }
    });

    const responseText = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) {
      throw new Error('Gemini API returned an empty response.');
    }
    return JSON.parse(responseText.trim());
  }

  /**
   * Constructs system instructions for the LLM
   */
  generateSystemPrompt(session, matchedProducts, matchedFAQs) {
    const productContext = matchedProducts.length > 0 
      ? matchedProducts.map(p => `Product ID: ${p.id}\nName: ${p.name}\nPrice: ₹${p.price}\nStock: ${p.stock_status}\nSizes: ${p.sizes.join(', ')}\nLink: ${p.permalink}`).join('\n\n')
      : 'No matching products found in the catalog.';

    const faqContext = matchedFAQs.length > 0
      ? matchedFAQs.map(f => `Question: ${f.question}\nAnswer: ${f.answer}`).join('\n\n')
      : 'No specific FAQ matching. Standard rules: 3-5 days delivery for metros, 5-7 days other. ₹50 COD fee, FREE shipping on prepaid online orders.';

    return `You are a helpful, professional, and friendly AI Sales Assistant for "Theaurax.in" (a premium football jerseys retailer and wholesaler in India). Your goal is to reply to customer messages on WhatsApp/Instagram, solve their queries, recommend products, and guide them to make a successful purchase.

Use the following Context to answer:
---
[PRODUCT SEARCH RESULTS]
${productContext}

[RELEVANT STORE FAQs]
${faqContext}

[CURRENT CUSTOMER SESSION STATE]
${JSON.stringify(session, null, 2)}
---

State Machine Flow Rules:
1. The assistant guides the customer through a step-by-step order collection flow if the customer expresses intent to buy a specific jersey:
   - State 'IDLE': Normal Q&A. If the user indicates buying a specific jersey (or matches a search product and expresses a desire to order/buy), push the product details { productId: id, name, price } to the "cart", transition state to 'COLLECTING_SIZE', and ask what size they need (mention the available sizes from the product catalog).
   - State 'COLLECTING_SIZE': Ask for size. Once they provide a size matching the available list, store it in the cart item and transition state to 'COLLECTING_QTY'. If the size is invalid, gently ask them to choose one of the available sizes.
   - State 'COLLECTING_QTY': Ask how many jerseys. Once they specify quantity, parse it as a number, store it in the cart item, and transition state to 'COLLECTING_ADDRESS'. (If quantity is >= ${config.owner.bulkThreshold}, set state to 'IDLE', set "requiresEscalation" to true, and alert the wholesale team).
   - State 'COLLECTING_ADDRESS': Ask for their shipping address. Once provided, save it to "address" and transition state to 'CONFIRMING_ORDER'.
   - State 'CONFIRMING_ORDER': Display a neat order summary (Product, Size, Qty, Total Price) and ask: "Does this look correct? Reply YES to confirm or NO to start over."
   - Once they reply YES in 'CONFIRMING_ORDER', clear/reset the session state back to 'IDLE', mark status as checkout/complete, and say: "Order confirmed! A support representative will send your invoice and checkout link shortly."

Rules for your response:
1. **Be Concise and Engaging**: WhatsApp/Instagram messages should be easy to read. Use bullet points and emojis. Keep paragraphs short (1-2 sentences).
2. **Sales-Driven**: Always invite them to order. If products are listed, include their price and direct link. Example: "You can buy it here: [link]".
3. **No Markup/HTML**: Do not use Markdown headers (# or ##) or HTML tags. You can use standard WhatsApp formatting: *bold* for emphasis (e.g. *₹799*).

Generate your response as a JSON object with the following keys:
{
  "replyText": "The actual message text to send to the user (with emojis, WhatsApp formatting, and product links if applicable)",
  "intent": "one of: faq, product_query, bulk_order, checkout_guidance, other",
  "requiresEscalation": true/false (set to true if bulk order or complex custom request),
  "suggestedProductIds": [list of product IDs that match their query],
  "sessionUpdate": {
    "state": "The updated state: IDLE, COLLECTING_SIZE, COLLECTING_QTY, COLLECTING_ADDRESS, or CONFIRMING_ORDER",
    "cart": [updated array of cart items],
    "address": "updated address string or null",
    "customPrinting": "updated custom printing details or null"
  }
}`;
  }

  /**
   * Fallback rule-based state machine for conversation flow when LLMs are not responsive
   */
  processFallbackStateFlow(session, userQuery, matchedProducts, matchedFAQs, isBulkIntent) {
    let replyText = '';
    let intent = 'other';
    let requiresEscalation = false;
    const cleanQuery = userQuery.toLowerCase().trim();
    const suggestedProductIds = matchedProducts.map(p => p.id);

    // Initial state cloned to sessionUpdate
    const sessionUpdate = {
      state: session.state,
      cart: [...session.cart],
      address: session.address,
      customPrinting: session.customPrinting
    };

    // 0. Handle bulk order override at any point
    if (isBulkIntent) {
      sessionUpdate.state = 'IDLE';
      sessionUpdate.cart = [];
      sessionUpdate.address = null;
      requiresEscalation = true;
      replyText = `⚽ *Theaurax Bulk & Team Orders* ⚽\n\nYes, we offer special wholesale pricing for team kits and orders of *${config.owner.bulkThreshold}+ jerseys*!\n\nCould you please let us know:\n1. Which team/club jerseys you need?\n2. Approximate quantity and sizes?\n3. Do you need custom names & numbers printed?\n\nI will forward your inquiry to our wholesale team right away, and they will message you here directly.`;
      return { replyText, intent: 'bulk_order', requiresEscalation, suggestedProductIds, sessionUpdate };
    }

    // 1. IDLE STATE: Standard FAQ and Product query handling
    if (session.state === 'IDLE') {
      const buyKeywords = ['buy', 'order', 'purchase', 'want to get', 'checkout', 'size chart', 'in stock', 'price of'];
      const isBuyingIntent = buyKeywords.some(kw => cleanQuery.includes(kw));

      if (matchedProducts.length > 0 && isBuyingIntent) {
        const prod = matchedProducts[0];
        const newCartItem = {
          productId: prod.id,
          name: prod.name,
          price: parseFloat(prod.price || '849'),
          size: null,
          qty: 1
        };
        sessionUpdate.cart = [newCartItem];
        sessionUpdate.state = 'COLLECTING_SIZE';
        intent = 'checkout_guidance';
        replyText = `👋 Hey! I can help you place an order for the *${prod.name}* (₹${prod.price}).\n\nWhat size do you need? Available sizes: *${prod.sizes.join(', ') || 'S, M, L, XL, XXL'}*.`;
      } else if (matchedProducts.length > 0) {
        intent = 'product_query';
        const prod = matchedProducts[0];
        replyText = `👋 Hey! Yes, we have *${prod.name}* available!\n\n💵 *Price:* ₹${prod.price}\n📦 *Stock:* ${prod.stock_status === 'instock' ? 'In Stock' : 'Out of Stock'}\n👕 *Sizes:* ${prod.sizes.join(', ') || 'S, M, L, XL, XXL'}\n\n🔗 *Buy here:* ${prod.permalink}\n\nWould you like to place an order? I can guide you through the process here!`;
      } else if (matchedFAQs.length > 0) {
        intent = 'faq';
        replyText = `👋 Hello!\n\n${matchedFAQs[0].answer}\n\nLet me know if you'd like to browse our catalog or place an order!`;
      } else {
        intent = 'other';
        replyText = `👋 Welcome to *Theaurax*! \n\nI'm your AI Sales Assistant. We sell premium master-quality football jerseys starting at ₹799!\n\nAre you looking for a specific team's jersey (e.g., Real Madrid, Manchester United, Arsenal) or did you have a question about sizing, COD, or delivery?\n\nLet me know and I'll help you out!`;
      }
    }

    // 2. COLLECTING_SIZE STATE
    else if (session.state === 'COLLECTING_SIZE') {
      const queryTokens = cleanQuery.split(/[\s/,\-_?!.]+/);
      const sizes = ['s', 'm', 'l', 'xl', 'xxl'];
      const matchedSize = sizes.find(s => queryTokens.includes(s)) || sizes.find(s => cleanQuery === s);

      if (matchedSize) {
        const sizeUpper = matchedSize.toUpperCase();
        if (sessionUpdate.cart.length > 0) {
          sessionUpdate.cart[0].size = sizeUpper;
        }
        sessionUpdate.state = 'COLLECTING_QTY';
        intent = 'checkout_guidance';
        replyText = `Got it, size *${sizeUpper}*. \n\nHow many pieces of this jersey do you want to order?`;
      } else {
        replyText = `Please select a valid size: *S, M, L, XL, or XXL*. What size would you like?`;
      }
    }

    // 3. COLLECTING_QTY STATE
    else if (session.state === 'COLLECTING_QTY') {
      const numbers = cleanQuery.match(/\d+/);
      if (numbers) {
        const qty = parseInt(numbers[0], 10);
        if (qty >= config.owner.bulkThreshold) {
          sessionUpdate.state = 'IDLE';
          sessionUpdate.cart = [];
          requiresEscalation = true;
          intent = 'bulk_order';
          replyText = `Since you want to order *${qty}* pieces, you qualify for wholesale rates! I'm alerting our team to contact you right away.`;
        } else {
          if (sessionUpdate.cart.length > 0) {
            sessionUpdate.cart[0].qty = qty;
          }
          sessionUpdate.state = 'COLLECTING_ADDRESS';
          intent = 'checkout_guidance';
          replyText = `Understood, *${qty}* piece(s). \n\nWhat is your full shipping address? (Please include Name, Pincode, and Mobile number).`;
        }
      } else {
        replyText = `Please tell me the quantity you want to order as a number (e.g., 1, 2, 3).`;
      }
    }

    // 4. COLLECTING_ADDRESS STATE
    else if (session.state === 'COLLECTING_ADDRESS') {
      if (cleanQuery.length > 10) {
        sessionUpdate.address = userQuery;
        sessionUpdate.state = 'CONFIRMING_ORDER';
        intent = 'checkout_guidance';

        const item = sessionUpdate.cart[0] || { name: 'Jersey', price: 849, size: 'L', qty: 1 };
        const subtotal = item.price * item.qty;

        replyText = `📋 *Order Confirmation Details*:\n\n` +
                    `👕 *Jersey:* ${item.name}\n` +
                    `📏 *Size:* ${item.size}\n` +
                    `📦 *Quantity:* ${item.qty}\n` +
                    `📍 *Address:* ${userQuery}\n\n` +
                    `💵 *Grand Total:* ₹${subtotal} (FREE delivery for prepaid, ₹50 extra for COD).\n\n` +
                    `Does this look correct? Please reply *YES* to confirm your order, or *NO* to cancel and start over.`;
      } else {
        replyText = `That address seems too short. Please provide your complete delivery address, including Name, Mobile Number, and Pincode.`;
      }
    }

    // 5. CONFIRMING_ORDER STATE
    else if (session.state === 'CONFIRMING_ORDER') {
      const yesKeywords = ['yes', 'yeah', 'yep', 'correct', 'confirm', 'y', 'ok', 'haan'];
      const noKeywords = ['no', 'cancel', 'wrong', 'change', 'n'];

      if (yesKeywords.some(kw => cleanQuery.includes(kw))) {
        sessionUpdate.state = 'IDLE';
        intent = 'checkout_guidance';
        replyText = `🎉 *Order Confirmed!* Thank you for ordering with Theaurax.\n\n` +
                    `We are processing your invoice and checkout link. A customer support manager will ping you here shortly with details. Let us know if you need anything else!`;
        // Cart is cleared after confirmation
        sessionUpdate.cart = [];
        sessionUpdate.address = null;
      } else if (noKeywords.some(kw => cleanQuery.includes(kw))) {
        sessionUpdate.state = 'IDLE';
        sessionUpdate.cart = [];
        sessionUpdate.address = null;
        intent = 'checkout_guidance';
        replyText = `No problem! I have cancelled this order. What jersey or query can I help you with now?`;
      } else {
        replyText = `Please reply with *YES* to confirm this order and get your checkout link, or *NO* to cancel and start over.`;
      }
    }

    return { replyText, intent, requiresEscalation, suggestedProductIds, sessionUpdate };
  }

  /**
   * Check if user is asking for bulk/wholesale quantities
   */
  checkBulkIntent(query) {
    const cleanQuery = query.toLowerCase().trim();
    const bulkKeywords = ['bulk', 'wholesale', 'team kit', 'many pieces', 'wholesale price', 'team order'];
    if (bulkKeywords.some(kw => cleanQuery.includes(kw))) {
      return true;
    }

    const numberMatches = cleanQuery.match(/\d+/g);
    if (numberMatches) {
      const queryTokens = new Set(cleanQuery.split(/[\s/,\-_?!.]+/));
      const priceKeywords = ['rupees', 'rs', 'rupee', 'under', 'budget', 'price', 'cost', 'below'];
      const hasPriceKeyword = priceKeywords.some(kw => queryTokens.has(kw)) || cleanQuery.includes('₹');
      
      if (!hasPriceKeyword) {
        const quantityKeywords = ['pieces', 'pcs', 'qty', 'quantity', 'jerseys', 'items', 'sets', 'kits'];
        const hasQuantityKeyword = quantityKeywords.some(kw => queryTokens.has(kw));

        const hasLargeNumber = numberMatches.some(numStr => {
          const num = parseInt(numStr, 10);
          if (num >= 2020 && num <= 2030) return false; // ignore years
          
          // Realistic team order quantities (pincodes and mobile numbers are much larger)
          if (num >= config.owner.bulkThreshold && num <= 500) {
            // Require a quantity/unit keyword to avoid matching flat/house numbers (e.g. Flat 401)
            return hasQuantityKeyword;
          }
          return false;
        });

        if (hasLargeNumber) return true;
      }
    }
    return false;
  }
}

const aiService = new AIService();
export default aiService;

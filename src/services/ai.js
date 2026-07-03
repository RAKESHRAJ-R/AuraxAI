import OpenAI from 'openai';
import config from '../config/config.js';
import faqService from './faq.js';
import woocommerceService from './woocommerce.js';
import dbService from './db.js';
import { generateInvoicePDF } from './invoice.js';
import whatsappWebBot from './whatsapp-web-bot.js';
import telegramService from './telegram.js';
import sheetsService from './sheets.js';

class AIService {
  constructor() {
    const groqKey = process.env.GROQ_API_KEY || config.groq?.apiKey || '';
    if (groqKey && !groqKey.includes('your_groq')) {
      this.openai = new OpenAI({
        apiKey: groqKey,
        baseURL: "https://api.groq.com/openai/v1"
      });
      console.log(`[AI Service] Loaded Groq API Key for Agent.`);
    } else {
      console.warn(`[AI Service] No GROQ_API_KEY found!`);
      this.openai = null;
    }
  }

  generateSystemPrompt(session) {
    return `You are an expert, highly persuasive, and friendly AI Sales Assistant for "Theaurax.in" (a premium football jerseys retailer in India).
Your goal is to build a friendly connection and aggressively but politely guide customers to a successful checkout.

Language & Tone Rule (CRITICAL):
- MIRROR THE CUSTOMER'S LANGUAGE. 
- If the customer speaks purely in English, you MUST reply entirely in fluent, professional English. Do NOT use Tanglish.
- If the customer uses Tanglish or Tamil, you MUST switch to natural "Tanglish" (Tamil words written in English letters). 
- Tanglish Persona: Use words like "Bro", "Machan", "Kandippa", "Indha jersey ungaluku pakka va irukum!", "Unga full address anupunga machan, order podalam."
- English Persona: Be warm and highly professional. "Here are our best options for you!", "Could you please provide your full shipping address so we can confirm the order?"
- Never sound like a robot. Be local, friendly, and hype up the products.
- If a product search returns many items, ONLY show the top 2 or 3 most relevant jerseys.

Current Session Context:
Cart: ${JSON.stringify(session.cart || [])}
Address: ${session.address || 'Not provided'}

Instructions:
1. ALWAYS use 'search_products' when asked about jerseys. Never guess prices or stock.
2. If products are found, provide exact name, price, sizes, and permalink. Hype it up! (e.g., "Bro, indha jersey vera level!" OR "This jersey is absolutely stunning!")
3. When a user wants to buy, ask for size and quantity. Once BOTH are provided, use 'update_cart'.
4. After updating the cart, ask for their full shipping address (Name, Pincode, Mobile).
5. Once the address is provided, use 'set_shipping_address'.
6. If the tool says "Address saved", display an order summary and ask them to reply YES to confirm. Once confirmed, use 'confirm_order'. If the tool says it's a Bulk Order, follow the tool's instructions.
7. Use emojis naturally to make it engaging.
8. IMPORTANT: When calling a tool, do NOT output conversational text before or after the tool call in the same message. Just use the tool.
9. BE SMART: If they reply with "M 3", interpret it as Size M, Quantity 3 for the last discussed product. ALWAYS use the exact productId when updating the cart.`;
  }

  getTools() {
    return [
      {
        type: "function",
        function: {
          name: "search_products",
          description: "Search the WooCommerce catalog for jerseys by team, player, or design.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "The search keyword." } },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_faqs",
          description: "Get answers to frequently asked questions about shipping, COD, sizing, delivery time, etc.",
          parameters: {
            type: "object",
            properties: { topic: { type: "string", description: "The FAQ topic to search for." } },
            required: ["topic"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "update_cart",
          description: "Add a jersey to the user's cart. Call this ONLY after confirming size and quantity with the user.",
          parameters: {
            type: "object",
            properties: {
              productId: { type: "number", description: "WooCommerce ID of the product." },
              name: { type: "string", description: "Product name." },
              price: { type: "number", description: "Product price." },
              size: { type: "string", description: "Requested size (e.g. S, M, L)." },
              qty: { type: "number", description: "Quantity." }
            },
            required: ["productId", "name", "price", "size", "qty"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "set_shipping_address",
          description: "Save the user's shipping address after they provide Name, Pincode, and Mobile.",
          parameters: {
            type: "object",
            properties: { address: { type: "string", description: "The full shipping address." } },
            required: ["address"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "escalate_to_human",
          description: "Flag the conversation for human intervention if the customer wants a bulk/wholesale order (e.g. >= 10 items) or has a complex request.",
          parameters: {
            type: "object",
            properties: { 
              reason: { type: "string", description: "The reason for escalating to a human." },
              customerName: { type: "string", description: "The customer's name." },
              customerPhone: { type: "string", description: "The customer's phone number." },
              customerAddress: { type: "string", description: "The customer's full shipping address." }
            },
            required: ["reason", "customerName", "customerPhone", "customerAddress"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "confirm_order",
          description: "Finalize the order after the cart and shipping address are collected and the user has replied YES to confirm.",
          parameters: {
            type: "object",
            properties: {
              confirm: { type: "boolean", description: "Set to true to confirm." }
            },
            required: ["confirm"]
          }
        }
      }
    ];
  }

  sendEscalationAlert(senderId, userQuery, session) {
    const isSim = senderId.toString().includes('sim') || senderId.toString().includes('test');
    const channel = isSim ? 'Test Simulation' : 'Live Chat';
    
    const details = session.escalationDetails || {};
    const name = details.name || session.customerName || 'Unknown';
    const phone = details.phone || senderId.toString().replace(/[^0-9]/g, '');
    const address = details.address || session.address || 'Not provided';
    const reason = details.reason || 'Wholesale / Bulk Order';

    const mdAlertMsg = `🚨 *New Wholesale Lead Alert!* 🚨\n\n*Customer Details:*\n👤 Name: ${name}\n📱 Phone: ${phone}\n📍 Address: ${address}\n\n*Request Reason:*\n${reason}\n\n*Latest Message:*\n"${userQuery}"\n\nPlease step in to negotiate!`;
    const htmlAlertMsg = `🚨 <b>New Wholesale Lead Alert!</b><br><br><b>Customer Details:</b><br>👤 Name: ${name}<br>📱 Phone: ${phone}<br>📍 Address: ${address}<br><br><b>Reason:</b> ${reason}<br><b>Message:</b> "${userQuery}"`;

    const ownerNumber = config.owner?.whatsappNumber;
    if (ownerNumber && whatsappWebBot.client && whatsappWebBot.status === 'CONNECTED') {
      const cleanOwner = ownerNumber.replace(/[^0-9]/g, '') + '@c.us';
      whatsappWebBot.client.sendMessage(cleanOwner, mdAlertMsg).catch(err => {
        console.error('[AI Service] Failed to send WhatsApp owner escalation alert:', err.message);
      });
    }

    if (config.telegram?.botToken && config.telegram?.chatId) {
      telegramService.sendAlert(htmlAlertMsg).catch(err => {
        console.error('[AI Service] Failed to send Telegram owner escalation alert:', err.message);
      });
    }
  }

  async answerQuery(senderId, userQuery, customerName = null, customerPhone = null) {
    const session = await dbService.getSession(senderId);
    if (customerName && customerName !== 'Customer') session.customerName = customerName;

    session.history = session.history || [];

    // Log to Google Sheets if this is a first-time inquiry
    if (session.history.length === 0) {
      sheetsService.appendRow([
        new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 
        customerPhone || senderId.replace(/[^0-9]/g, ''), 
        customerName || 'Customer', 
        userQuery
      ]).catch(e => console.error(e));
    }

    const validHistory = session.history.filter(m => m.role === 'user' || m.role === 'assistant');
    session.history = validHistory.slice(-10);
    
    let resultText = "";
    let isConfirmed = false;
    let requiresEscalation = false;

    if (!this.openai) {
      resultText = "I'm currently undergoing maintenance. Please reach out to our support number directly on WhatsApp.";
      return { replyText: resultText, intent: 'error', requiresEscalation: false, suggestedProductIds: [] };
    }

    let messages = [
      { role: "system", content: this.generateSystemPrompt(session) }
    ];

    for (const msg of session.history) {
      messages.push({ role: msg.role, content: msg.content || "" });
    }
    messages.push({ role: "user", content: userQuery });

    let keepLooping = true;
    let loops = 0;

    while (keepLooping && loops < 5) {
      loops++;
      try {
        const completion = await this.openai.chat.completions.create({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          messages: messages,
          tools: this.getTools(),
          tool_choice: "auto"
        });

        const responseMessage = completion.choices[0].message;
        
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          messages.push(responseMessage);
          
          for (const toolCall of responseMessage.tool_calls) {
            const fnName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            let toolResultObj = {};

            if (fnName === "search_products") {
              const products = woocommerceService.searchProducts(args.query || "");
              toolResultObj = { products: products.length > 0 ? products : null, message: products.length > 0 ? "Found products" : "No matching products found. Advise user to search website: https://theaurax.in/?s=" + encodeURIComponent(args.query || "") };
            } else if (fnName === "get_faqs") {
              const faqs = faqService.searchFAQs(args.topic || "");
              toolResultObj = { faqs: faqs.length > 0 ? faqs : null, message: faqs.length > 0 ? "Found FAQs" : "No specific FAQ found." };
            } else if (fnName === "update_cart") {
              session.cart = [{
                productId: args.productId,
                name: args.name,
                price: args.price,
                size: args.size,
                qty: args.qty
              }];
              session.state = 'COLLECTING_ADDRESS';
              toolResultObj = { status: "success", message: "Cart updated successfully. Ask user for their shipping address next." };
            } else if (fnName === "set_shipping_address") {
              session.address = args.address;
              
              const totalQty = session.cart.reduce((sum, item) => sum + parseInt(item.qty || 0), 0);
              const bulkThreshold = config.owner?.bulkThreshold || 10;
              
              if (totalQty >= bulkThreshold) {
                requiresEscalation = true;
                session.requiresEscalation = true;
                session.state = 'IDLE';
                session.escalationDetails = {
                  reason: `Bulk Order (${totalQty} items)`,
                  name: session.customerName,
                  phone: senderId.replace(/[^0-9]/g, ''),
                  address: args.address
                };
                toolResultObj = { status: "success", message: `CRITICAL: Cart quantity is ${totalQty}, which is a bulk order. DO NOT ask to confirm order. Tell the user our wholesale team will reach out to them shortly.` };
              } else {
                session.state = 'CONFIRMING_ORDER';
                toolResultObj = { status: "success", message: "Address saved. Summarize the order and ask them to reply YES to confirm." };
              }
            } else if (fnName === "escalate_to_human") {
              requiresEscalation = true;
              session.requiresEscalation = true;
              session.state = 'IDLE';
              session.escalationDetails = {
                reason: args.reason,
                name: args.customerName,
                phone: args.customerPhone,
                address: args.customerAddress
              };
              toolResultObj = { status: "success", message: "Escalated. Tell the user our wholesale/support team will reach out to them shortly." };
            } else if (fnName === "confirm_order") {
              isConfirmed = true;
              session.state = 'IDLE';
              toolResultObj = { status: "success", message: "Order is confirmed. End the conversation politely." };
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify(toolResultObj)
            });
          }
        } else {
          resultText = responseMessage.content || "Sorry, I couldn't process that.";
          // Groq Bug Fix: Clean any leaked XML or malformed tool tags from the final text
          resultText = resultText.replace(/<?\/?function=.*?>.*?<\/function>/gs, '').trim();
          resultText = resultText.replace(/[a-zA-Z_]+>\s*\{.*?\}/gs, '').trim();
          if (!resultText) resultText = "Oops, let me try that again! What exactly were you looking for?";
          keepLooping = false;
        }
      } catch (err) {
        console.error('[AI Service] Groq API error:', err.error ? JSON.stringify(err.error) : err.message || err);
        resultText = "Oops! Something went wrong on my end. Please give me a second and try again!";
        keepLooping = false;
      }
    }

    session.history.push({ role: 'user', content: userQuery });
    session.history.push({ role: 'assistant', content: resultText });

    if (isConfirmed && session.cart && session.cart.length > 0) {
      try {
        const orderId = `order_${Date.now()}_${senderId.toString().substring(0, 4)}`;
        const invoicePath = await generateInvoicePDF(orderId, {
          userId: senderId,
          customerName: session.customerName || `Customer (${senderId})`,
          cart: session.cart,
          address: session.address
        });
        console.log(`[AI Service] Dynamic PDF proforma invoice created at: ${invoicePath}`);
        const baseUrl = config.baseUrl || 'http://localhost:3000';
        resultText += `\n\n📄 *Proforma Invoice Generated*:\nDownload here: ${baseUrl}/invoices/invoice_${orderId}.pdf`;
      } catch (invoiceErr) {
        console.error('[AI Service] Proforma invoice PDF generation failed:', invoiceErr.message);
      }
      session.cart = []; 
      session.address = null;
      session.history = [];
    }

    if (requiresEscalation) {
      this.sendEscalationAlert(senderId, userQuery, session);
      // Reset the session so future bulk orders also trigger alerts
      session.cart = [];
      session.address = null;
      session.history = [];
      session.hasEscalated = false;
      session.requiresEscalation = false;
    }

    await dbService.saveSession(senderId, session);
    
    await dbService.saveLead({
      userId: senderId,
      name: session.customerName || customerName || 'Customer',
      phone: senderId.replace(/[^0-9]/g, ''),
      channel: 'whatsapp',
      cart: session.cart || [],
      address: session.address || null,
      requiresEscalation: session.requiresEscalation || false,
      status: session.state === 'IDLE' && session.cart.length === 0 ? 'completed' : 'active',
      conversation: session.history || []
    });

    return {
      replyText: resultText,
      intent: 'agent_handled',
      requiresEscalation: requiresEscalation,
      suggestedProductIds: []
    };
  }
}

const aiService = new AIService();
export default aiService;

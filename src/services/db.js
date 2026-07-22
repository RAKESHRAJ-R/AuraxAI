import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const RETRY_QUEUE_FILE = path.join(DATA_DIR, 'retry_queue.json');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');

// Session default state template
const DEFAULT_SESSION = {
  state: 'IDLE',         // IDLE, COLLECTING_PRODUCT, COLLECTING_SIZE, COLLECTING_QTY, COLLECTING_ADDRESS, CONFIRMING_ORDER
  cart: [],              // Array of { productId, name, price, size, qty }
  address: null,         // Shipping address string
  customPrinting: null,  // { name, number } if customized
  lastActive: null,
  requiresEscalation: false,
  history: []            // Array of { role: 'user'|'model', content: string }
};

class DatabaseService {
  constructor() {
    this.mongoClient = null;
    this.db = null;
    this.useMongo = false;

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Initialize local JSON files if they don't exist
    if (!fs.existsSync(SESSIONS_FILE)) {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}), 'utf-8');
    }
    if (!fs.existsSync(LEADS_FILE)) {
      fs.writeFileSync(LEADS_FILE, JSON.stringify([]), 'utf-8');
    }
    if (!fs.existsSync(CUSTOMERS_FILE)) {
      fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([]), 'utf-8');
    }
    if (!fs.existsSync(RETRY_QUEUE_FILE)) {
      fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify([]), 'utf-8');
    }
    if (!fs.existsSync(KNOWLEDGE_FILE)) {
      fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify([]), 'utf-8');
    }

    this.initMongo();
  }

  async initMongo() {
    const mongoUri = process.env.MONGODB_URI;
    if (mongoUri) {
      try {
        // Dynamically import mongodb to avoid crash if not installed
        const { MongoClient } = await import('mongodb');
        this.mongoClient = new MongoClient(mongoUri);
        await this.mongoClient.connect();
        this.db = this.mongoClient.db('theaurax_assistant');
        this.useMongo = true;
        console.log('[Database Service] Successfully connected to MongoDB.');
      } catch (err) {
        console.warn('[Database Service] Failed to connect to MongoDB, falling back to local JSON files:', err.message);
        this.useMongo = false;
      }
    } else {
      console.log('[Database Service] No MONGODB_URI found. Using local JSON files for storage.');
    }
  }

  // --- Session Methods ---

  async getSession(userId) {
    if (!userId) return { ...DEFAULT_SESSION };

    if (this.useMongo) {
      try {
        const session = await this.db.collection('sessions').findOne({ userId });
        return session ? { ...DEFAULT_SESSION, ...session } : { ...DEFAULT_SESSION, userId };
      } catch (err) {
        console.error('[Database Service] MongoDB getSession error:', err.message);
      }
    }

    // JSON Fallback
    try {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      const session = data[userId];
      return session ? { ...DEFAULT_SESSION, ...session } : { ...DEFAULT_SESSION, userId };
    } catch (err) {
      console.error('[Database Service] Local JSON read session error:', err.message);
      return { ...DEFAULT_SESSION, userId };
    }
  }

  async saveSession(userId, sessionData) {
    if (!userId) return false;

    const dataToSave = {
      ...sessionData,
      userId,
      lastActive: new Date().toISOString()
    };

    if (this.useMongo) {
      try {
        await this.db.collection('sessions').updateOne(
          { userId },
          { $set: dataToSave },
          { upsert: true }
        );
        return true;
      } catch (err) {
        console.error('[Database Service] MongoDB saveSession error:', err.message);
      }
    }

    // JSON Fallback
    try {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      data[userId] = dataToSave;
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[Database Service] Local JSON save session error:', err.message);
      return false;
    }
  }

  async clearSession(userId) {
    if (!userId) return false;

    if (this.useMongo) {
      try {
        await this.db.collection('sessions').deleteOne({ userId });
        return true;
      } catch (err) {
        console.error('[Database Service] MongoDB clearSession error:', err.message);
      }
    }

    // JSON Fallback
    try {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      delete data[userId];
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[Database Service] Local JSON clear session error:', err.message);
      return false;
    }
  }

  async getAllSessions() {
    if (this.useMongo) {
      try {
        return await this.db.collection('sessions').find({}).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllSessions error:', err.message);
        return [];
      }
    }

    // JSON Fallback
    try {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      return Object.values(data);
    } catch (err) {
      console.error('[Database Service] Local JSON getAllSessions error:', err.message);
      return [];
    }
  }

  // --- Lead & Order Tracking Methods ---

  async saveLead(leadData) {
    const newLead = {
      id: leadData.id || `lead_${Date.now()}`,
      userId: leadData.userId,
      name: leadData.name || 'Unknown User',
      phone: leadData.phone || '',
      channel: leadData.channel || 'instagram', // instagram, whatsapp
      cart: leadData.cart || [],
      address: leadData.address || null,
      status: leadData.status || 'lead', // lead, billing, checkout, completed, cold
      requiresEscalation: leadData.requiresEscalation || false,
      conversation: leadData.conversation || [],
      createdAt: leadData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (this.useMongo) {
      try {
        const { createdAt, ...updateFields } = newLead;
        await this.db.collection('leads').updateOne(
          { userId: newLead.userId },
          { 
            $set: updateFields,
            $setOnInsert: { createdAt }
          },
          { upsert: true }
        );
        return newLead;
      } catch (err) {
        console.error('[Database Service] MongoDB saveLead error:', err.message);
      }
    }

    // JSON Fallback
    try {
      const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
      const existingIndex = leads.findIndex(l => l.userId === newLead.userId);
      
      if (existingIndex !== -1) {
        leads[existingIndex] = {
          ...leads[existingIndex],
          ...newLead,
          id: leads[existingIndex].id,
          createdAt: leads[existingIndex].createdAt
        };
      } else {
        leads.push(newLead);
      }

      fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
      return newLead;
    } catch (err) {
      console.error('[Database Service] Local JSON saveLead error:', err.message);
      return newLead;
    }
  }

  async getActiveLeads() {
    if (this.useMongo) {
      try {
        return await this.db.collection('leads').find({ status: { $ne: 'completed' } }).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getActiveLeads error:', err.message);
      }
    }

    // JSON Fallback
    try {
      const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
      return leads.filter(l => l.status !== 'completed');
    } catch (err) {
      console.error('[Database Service] Local JSON getActiveLeads error:', err.message);
      return [];
    }
  }

  async getAllLeads() {
    if (this.useMongo) {
      try {
        return await this.db.collection('leads').find({}).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllLeads error:', err.message);
        return [];
      }
    }

    // JSON Fallback
    try {
      return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
    } catch (err) {
      console.error('[Database Service] Local JSON getAllLeads error:', err.message);
      return [];
    }
  }

  // --- Knowledge Hub (client-editable corrections/FAQs that the bot consults) ---
  // Each entry: { id, keywords:[], question, answer, language:'both'|'english'|'tanglish',
  //   source:'manual'|'correction', active:bool, createdAt, updatedAt }

  async getAllKnowledge() {
    if (this.useMongo) {
      try {
        return await this.db.collection('knowledge').find({}).sort({ updatedAt: -1 }).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllKnowledge error:', err.message);
        return [];
      }
    }
    try {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'));
    } catch (err) {
      console.error('[Database Service] Local JSON getAllKnowledge error:', err.message);
      return [];
    }
  }

  async getActiveKnowledge() {
    const all = await this.getAllKnowledge();
    return all.filter(k => k.active !== false);
  }

  async saveKnowledge(entry) {
    const now = new Date().toISOString();
    const record = {
      id: entry.id || `kn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      keywords: Array.isArray(entry.keywords) ? entry.keywords.map(k => String(k).trim()).filter(Boolean) : [],
      question: (entry.question || '').trim(),
      answer: (entry.answer || '').trim(),
      language: ['both', 'english', 'tanglish'].includes(entry.language) ? entry.language : 'both',
      // 'auto' = an unanswered-question draft the diagnosis queue created for the owner to fill in.
      source: ['manual', 'correction', 'auto'].includes(entry.source) ? entry.source : 'manual',
      active: entry.active !== false,
      createdAt: entry.createdAt || now,
      updatedAt: now,
    };
    // Carry the "asked N times" counter for auto-drafts (how many conversations hit this gap).
    if (entry.hits !== undefined) record.hits = entry.hits;

    if (this.useMongo) {
      try {
        const { createdAt, ...updateFields } = record;
        await this.db.collection('knowledge').updateOne(
          { id: record.id },
          { $set: updateFields, $setOnInsert: { createdAt } },
          { upsert: true }
        );
        return record;
      } catch (err) {
        console.error('[Database Service] MongoDB saveKnowledge error:', err.message);
      }
    }

    try {
      const all = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'));
      const idx = all.findIndex(k => k.id === record.id);
      if (idx !== -1) {
        record.createdAt = all[idx].createdAt || record.createdAt;
        all[idx] = record;
      } else {
        all.push(record);
      }
      fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(all, null, 2), 'utf-8');
      return record;
    } catch (err) {
      console.error('[Database Service] Local JSON saveKnowledge error:', err.message);
      return record;
    }
  }

  async deleteKnowledge(id) {
    if (this.useMongo) {
      try {
        await this.db.collection('knowledge').deleteOne({ id });
        return true;
      } catch (err) {
        console.error('[Database Service] MongoDB deleteKnowledge error:', err.message);
      }
    }
    try {
      const all = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'));
      const next = all.filter(k => k.id !== id);
      fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(next, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[Database Service] Local JSON deleteKnowledge error:', err.message);
      return false;
    }
  }

  // --- Auto-diagnosed "needs answer" drafts (the unanswered-question queue) ---
  // The diagnosis pass (diagnose.js) records questions the bot couldn't handle well as
  // INACTIVE knowledge drafts (source:'auto', empty answer). They show up in the Teach
  // list marked "needs answer" for the owner to fill in. Because active:false, the matcher
  // (getActiveKnowledge) never serves them to a customer until the owner answers + activates.

  /** Upsert an unanswered-question draft, de-duplicated by normalized question text. */
  async saveUnansweredDraft({ question, keywords = [], language = 'both' }) {
    const q = (question || '').trim();
    if (!q) return { created: false };
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const target = norm(q);
    if (!target) return { created: false };

    const all = await this.getAllKnowledge();
    const existing = all.find(k => norm(k.question) === target);
    if (existing) {
      // The owner dismissed this question → it's a tombstone; never re-queue it.
      if (existing.dismissed) return { created: false, dismissed: true };
      // Already answered by the owner (or a manual entry covers it) → nothing to queue.
      if (existing.answer && existing.answer.trim()) return { created: false, alreadyAnswered: true };
      // Still an open draft → bump how many times it's been hit.
      await this.saveKnowledge({
        ...existing, source: 'auto', active: false, hits: (existing.hits || 1) + 1,
      });
      return { created: false, bumped: true };
    }

    const entry = await this.saveKnowledge({
      question: q, answer: '', keywords, language, source: 'auto', active: false, hits: 1,
    });
    return { created: true, entry };
  }

  /** Count open drafts still waiting for an answer (for the Knowledge Hub badge). */
  async countPendingKnowledge() {
    const all = await this.getAllKnowledge();
    return all.filter(k => k.source === 'auto' && !k.dismissed && !(k.answer && k.answer.trim())).length;
  }

  /**
   * Permanently dismiss an auto-draft: keep it as a hidden tombstone (dismissed:true) so
   * the diagnosis pass never re-creates it, but exclude it from the list and the badge.
   * This is what makes "Dismiss" stick — a plain delete would just get regenerated on the
   * next scan because the underlying flagged conversation still exists.
   */
  async dismissKnowledge(id) {
    const patch = { dismissed: true, active: false, updatedAt: new Date().toISOString() };
    if (this.useMongo) {
      try {
        await this.db.collection('knowledge').updateOne({ id }, { $set: patch });
        return true;
      } catch (err) {
        console.error('[Database Service] MongoDB dismissKnowledge error:', err.message);
      }
    }
    try {
      const all = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'));
      const idx = all.findIndex(k => k.id === id);
      if (idx !== -1) { all[idx] = { ...all[idx], ...patch }; fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(all, null, 2), 'utf-8'); }
      return true;
    } catch (err) {
      console.error('[Database Service] Local JSON dismissKnowledge error:', err.message);
      return false;
    }
  }

  // --- Customer Registry (for marketing campaigns) ---

  async saveCustomer(userId, name, phone, channel = 'whatsapp') {
    if (!userId) return;
    const record = {
      userId,
      name: name || 'Customer',
      phone: (phone || userId.replace(/\D/g, '')).slice(-10),
      channel,
      updatedAt: new Date().toISOString()
    };

    if (this.useMongo) {
      try {
        await this.db.collection('customers').updateOne(
          { userId },
          { $set: record, $setOnInsert: { createdAt: new Date().toISOString() } },
          { upsert: true }
        );
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB saveCustomer error:', err.message);
      }
    }

    try {
      const customers = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf-8'));
      const idx = customers.findIndex(c => c.userId === userId);
      if (idx >= 0) {
        customers[idx] = { ...customers[idx], ...record };
      } else {
        customers.push({ ...record, createdAt: new Date().toISOString() });
      }
      fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database Service] Local JSON saveCustomer error:', err.message);
    }
  }

  async getAllCustomers() {
    if (this.useMongo) {
      try {
        return await this.db.collection('customers').find({}).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllCustomers error:', err.message);
        return [];
      }
    }
    try {
      return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf-8'));
    } catch (err) {
      return [];
    }
  }

  async updateLeadFollowUp(userId) {
    if (this.useMongo) {
      try {
        await this.db.collection('leads').updateOne(
          { userId },
          { $inc: { followUpCount: 1 }, $set: { lastFollowUp: new Date().toISOString() } }
        );
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB updateLeadFollowUp error:', err.message);
      }
    }
    try {
      const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
      const idx = leads.findIndex(l => l.userId === userId);
      if (idx >= 0) {
        leads[idx].followUpCount = (leads[idx].followUpCount || 0) + 1;
        leads[idx].lastFollowUp = new Date().toISOString();
        fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
      }
    } catch (err) {
      console.error('[Database Service] Local JSON updateLeadFollowUp error:', err.message);
    }
  }

  // --- Persistent Retry Queue (survives server restarts) ---

  async savePendingRetry(senderId, userQuery, customerName, customerPhone, retryAt) {
    const entry = { senderId, userQuery, customerName, customerPhone, retryAt, createdAt: new Date().toISOString() };

    if (this.useMongo) {
      try {
        await this.db.collection('retry_queue').updateOne(
          { senderId, userQuery },
          { $set: entry },
          { upsert: true }
        );
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB savePendingRetry error:', err.message);
      }
    }

    // JSON Fallback
    try {
      const queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf-8'));
      const idx = queue.findIndex(e => e.senderId === senderId && e.userQuery === userQuery);
      if (idx >= 0) {
        queue[idx] = entry;
      } else {
        queue.push(entry);
      }
      fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database Service] Local JSON savePendingRetry error:', err.message);
    }
  }

  async getDueRetries() {
    const now = Date.now();

    if (this.useMongo) {
      try {
        return await this.db.collection('retry_queue').find({
          retryAt: { $lte: now }
        }).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getDueRetries error:', err.message);
        return [];
      }
    }

    // JSON Fallback
    try {
      const queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf-8'));
      return queue.filter(e => e.retryAt <= now);
    } catch (err) {
      console.error('[Database Service] Local JSON getDueRetries error:', err.message);
      return [];
    }
  }

  async deletePendingRetry(senderId, userQuery) {
    if (this.useMongo) {
      try {
        await this.db.collection('retry_queue').deleteOne({ senderId, userQuery });
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB deletePendingRetry error:', err.message);
      }
    }

    // JSON Fallback
    try {
      const queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf-8'));
      const filtered = queue.filter(e => !(e.senderId === senderId && e.userQuery === userQuery));
      fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database Service] Local JSON deletePendingRetry error:', err.message);
    }
  }

  async getAllPendingRetries() {
    if (this.useMongo) {
      try {
        return await this.db.collection('retry_queue').find({}).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllPendingRetries error:', err.message);
        return [];
      }
    }
    try {
      return JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf-8'));
    } catch (err) {
      return [];
    }
  }
}

const dbService = new DatabaseService();
export default dbService;

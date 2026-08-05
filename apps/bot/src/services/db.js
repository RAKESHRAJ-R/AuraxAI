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
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
// Knowledge SOURCES (uploaded documents + crawled websites) and the searchable text
// CHUNKS extracted from them. Kept separate from knowledge.json, which holds the
// hand-written Q&A pairs — different shape, different lifecycle, and chunks are bulky
// (each carries an embedding vector).
const KNOWLEDGE_SOURCES_FILE = path.join(DATA_DIR, 'knowledge_sources.json');
const KNOWLEDGE_CHUNKS_FILE = path.join(DATA_DIR, 'knowledge_chunks.json');
// Missed-message catch-up: `meta` holds the watermark (the newest message timestamp we
// have definitely handled), `catchup_queue` holds chats that were missed and are waiting
// to be answered at a safe drip rate. Both MUST be persistent — the whole point is that a
// restart does not lose customers, so a queue held only in memory would defeat the feature.
const META_FILE = path.join(DATA_DIR, 'meta.json');
const CATCHUP_QUEUE_FILE = path.join(DATA_DIR, 'catchup_queue.json');

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
    if (!fs.existsSync(TICKETS_FILE)) {
      fs.writeFileSync(TICKETS_FILE, JSON.stringify([]), 'utf-8');
    }
    if (!fs.existsSync(KNOWLEDGE_SOURCES_FILE)) {
      fs.writeFileSync(KNOWLEDGE_SOURCES_FILE, JSON.stringify([]), 'utf-8');
    }
    if (!fs.existsSync(KNOWLEDGE_CHUNKS_FILE)) {
      fs.writeFileSync(KNOWLEDGE_CHUNKS_FILE, JSON.stringify([]), 'utf-8');
    }
    if (!fs.existsSync(META_FILE)) {
      fs.writeFileSync(META_FILE, JSON.stringify({}), 'utf-8');
    }
    if (!fs.existsSync(CATCHUP_QUEUE_FILE)) {
      fs.writeFileSync(CATCHUP_QUEUE_FILE, JSON.stringify([]), 'utf-8');
    }

    // Callers await this before serving traffic, so the store is decided once and
    // never switches mid-run (a switch would strand whatever was written meanwhile).
    this.ready = this.initMongo();
  }

  async initMongo() {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      console.log('[Database Service] No MONGODB_URI found. Using local JSON files for storage.');
      return;
    }

    // A mongodb+srv:// URI needs a DNS SRV lookup, which Node resolves against the first
    // configured nameserver — one SERVFAIL there fails the whole connect. That blip is
    // transient, but the JSON fallback below is permanent for the life of the process,
    // so a single unlucky moment at boot used to cost an entire run's writes. Retry hard.
    const ATTEMPTS = 5;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        // Dynamically import mongodb to avoid crash if not installed
        const { MongoClient } = await import('mongodb');
        this.mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 15000 });
        await this.mongoClient.connect();
        this.db = this.mongoClient.db('theaurax_assistant');
        this.useMongo = true;
        const suffix = attempt > 1 ? ` (on attempt ${attempt}/${ATTEMPTS})` : '';
        console.log(`[Database Service] Successfully connected to MongoDB${suffix}.`);
        return;
      } catch (err) {
        await this.mongoClient?.close().catch(() => {});
        this.mongoClient = null;
        console.warn(`[Database Service] MongoDB connect attempt ${attempt}/${ATTEMPTS} failed: ${err.message}`);
        if (attempt < ATTEMPTS) {
          const waitMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }

    this.useMongo = false;
    this.warnJsonFallback();
  }

  // Falling back to JSON is not a graceful degradation — it silently forks the data into
  // a second store that MongoDB will never see. Make that impossible to miss.
  warnJsonFallback() {
    const banner =
      '\n' +
      '='.repeat(72) + '\n' +
      '  ⚠️  RUNNING ON LOCAL JSON FILES — MongoDB is NOT connected.\n' +
      '  Everything written this run stays in src/data/*.json and will NOT be\n' +
      '  in MongoDB. Fix the connection and re-run `npm run migrate-mongo`\n' +
      '  to fold this run\'s data back in, or the two stores stay diverged.\n' +
      '='.repeat(72) + '\n';
    console.warn(banner);
    // Repeat every 10 min so a long-running process can't quietly stay in this state.
    const reminder = setInterval(() => {
      console.warn('[Database Service] ⚠️  Still on JSON fallback — MongoDB never connected this run.');
    }, 10 * 60 * 1000);
    reminder.unref?.();
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

  // --- Knowledge SOURCES (uploaded documents + crawled websites) ---
  // A source is the thing the owner added ("sizechart.pdf", "https://theaurax.in/shipping").
  // Its extracted text lives in knowledge_chunks as many small searchable rows, each
  // carrying an embedding vector. Sources and chunks are always written together:
  // replaceKnowledgeChunks() wipes a source's old chunks before inserting the new set, so
  // re-indexing never leaves stale text behind to be retrieved.
  // Shape: { id, type:'document'|'website', title, url, filename, chunkCount, charCount,
  //          status:'ready'|'error', error, embedded:bool, createdAt, updatedAt }

  async getAllKnowledgeSources() {
    if (this.useMongo) {
      try {
        return await this.db.collection('knowledge_sources').find({}).sort({ createdAt: -1 }).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllKnowledgeSources error:', err.message);
        return [];
      }
    }
    try {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_SOURCES_FILE, 'utf-8'));
    } catch (err) {
      console.error('[Database Service] Local JSON getAllKnowledgeSources error:', err.message);
      return [];
    }
  }

  async saveKnowledgeSource(source) {
    const now = new Date().toISOString();
    const record = {
      id: source.id || `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: source.type === 'website' ? 'website' : 'document',
      title: (source.title || '').trim() || 'Untitled',
      url: source.url || null,
      filename: source.filename || null,
      chunkCount: source.chunkCount || 0,
      charCount: source.charCount || 0,
      pageCount: source.pageCount || null,
      status: ['ready', 'error', 'indexing'].includes(source.status) ? source.status : 'ready',
      error: source.error || null,
      embedded: source.embedded === true,
      language: ['both', 'english', 'tanglish'].includes(source.language) ? source.language : 'both',
      active: source.active !== false,
      createdAt: source.createdAt || now,
      updatedAt: now,
    };

    if (this.useMongo) {
      try {
        const { createdAt, ...updateFields } = record;
        await this.db.collection('knowledge_sources').updateOne(
          { id: record.id },
          { $set: updateFields, $setOnInsert: { createdAt } },
          { upsert: true }
        );
        return record;
      } catch (err) {
        console.error('[Database Service] MongoDB saveKnowledgeSource error:', err.message);
      }
    }

    try {
      const all = JSON.parse(fs.readFileSync(KNOWLEDGE_SOURCES_FILE, 'utf-8'));
      const idx = all.findIndex(s => s.id === record.id);
      if (idx !== -1) {
        record.createdAt = all[idx].createdAt || record.createdAt;
        all[idx] = record;
      } else {
        all.push(record);
      }
      fs.writeFileSync(KNOWLEDGE_SOURCES_FILE, JSON.stringify(all, null, 2), 'utf-8');
      return record;
    } catch (err) {
      console.error('[Database Service] Local JSON saveKnowledgeSource error:', err.message);
      return record;
    }
  }

  /** Delete a source AND every chunk belonging to it — orphan chunks would still be retrievable. */
  async deleteKnowledgeSource(id) {
    await this.deleteChunksBySource(id);
    if (this.useMongo) {
      try {
        await this.db.collection('knowledge_sources').deleteOne({ id });
        return true;
      } catch (err) {
        console.error('[Database Service] MongoDB deleteKnowledgeSource error:', err.message);
      }
    }
    try {
      const all = JSON.parse(fs.readFileSync(KNOWLEDGE_SOURCES_FILE, 'utf-8'));
      fs.writeFileSync(KNOWLEDGE_SOURCES_FILE, JSON.stringify(all.filter(s => s.id !== id), null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[Database Service] Local JSON deleteKnowledgeSource error:', err.message);
      return false;
    }
  }

  // --- Knowledge CHUNKS (the searchable slices of each source) ---
  // Shape: { id, sourceId, sourceTitle, sourceType, url, text, embedding:number[]|null, order }

  async getAllKnowledgeChunks() {
    if (this.useMongo) {
      try {
        return await this.db.collection('knowledge_chunks').find({}).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllKnowledgeChunks error:', err.message);
        return [];
      }
    }
    try {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_CHUNKS_FILE, 'utf-8'));
    } catch (err) {
      console.error('[Database Service] Local JSON getAllKnowledgeChunks error:', err.message);
      return [];
    }
  }

  async deleteChunksBySource(sourceId) {
    if (this.useMongo) {
      try {
        await this.db.collection('knowledge_chunks').deleteMany({ sourceId });
        return true;
      } catch (err) {
        console.error('[Database Service] MongoDB deleteChunksBySource error:', err.message);
      }
    }
    try {
      const all = JSON.parse(fs.readFileSync(KNOWLEDGE_CHUNKS_FILE, 'utf-8'));
      fs.writeFileSync(KNOWLEDGE_CHUNKS_FILE, JSON.stringify(all.filter(c => c.sourceId !== sourceId), null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[Database Service] Local JSON deleteChunksBySource error:', err.message);
      return false;
    }
  }

  /**
   * Replace all chunks for a source in one shot (delete-then-insert). Re-indexing a
   * source must never leave the previous version's text searchable alongside the new one.
   */
  async replaceKnowledgeChunks(sourceId, chunks) {
    await this.deleteChunksBySource(sourceId);
    const records = (chunks || []).map((c, i) => ({
      id: `chk_${sourceId}_${i}`,
      sourceId,
      sourceTitle: c.sourceTitle || '',
      sourceType: c.sourceType || 'document',
      url: c.url || null,
      text: c.text || '',
      embedding: Array.isArray(c.embedding) ? c.embedding : null,
      order: i,
    })).filter(r => r.text);

    if (!records.length) return 0;

    if (this.useMongo) {
      try {
        await this.db.collection('knowledge_chunks').insertMany(records);
        return records.length;
      } catch (err) {
        console.error('[Database Service] MongoDB replaceKnowledgeChunks error:', err.message);
      }
    }
    try {
      const all = JSON.parse(fs.readFileSync(KNOWLEDGE_CHUNKS_FILE, 'utf-8'));
      all.push(...records);
      fs.writeFileSync(KNOWLEDGE_CHUNKS_FILE, JSON.stringify(all, null, 2), 'utf-8');
      return records.length;
    } catch (err) {
      console.error('[Database Service] Local JSON replaceKnowledgeChunks error:', err.message);
      return 0;
    }
  }

  /**
   * Total indexed characters across all sources — drives the storage bar in the admin UI.
   * Wati caps this at 1MB; we don't, but showing the number keeps the owner oriented.
   */
  async getKnowledgeStorageUsage() {
    const sources = await this.getAllKnowledgeSources();
    const chars = sources.reduce((sum, s) => sum + (s.charCount || 0), 0);
    return {
      chars,
      sources: sources.length,
      chunks: sources.reduce((sum, s) => sum + (s.chunkCount || 0), 0),
    };
  }

  // --- Support Tickets (after-sales: complaints, returns, tracking escalations) ---
  // Each ticket: { id, userId, name, phone, email, orderId, issueType, description,
  //   hasPhoto, status:'open'|'resolved', createdAt, updatedAt }. Created by the support
  //   agent's create_support_ticket tool; the owner is also alerted live via WhatsApp.

  async saveTicket(ticketData) {
    const now = new Date().toISOString();
    const ticket = {
      id: ticketData.id || `TKT-${Date.now().toString(36).toUpperCase()}`,
      userId: ticketData.userId || '',
      name: ticketData.name || 'Customer',
      phone: (ticketData.phone || '').replace(/\D/g, ''),
      email: ticketData.email || '',
      orderId: ticketData.orderId ? String(ticketData.orderId).replace(/\D/g, '') : '',
      issueType: ticketData.issueType || 'other',
      description: ticketData.description || '',
      hasPhoto: !!ticketData.hasPhoto,
      status: ticketData.status || 'open',
      createdAt: ticketData.createdAt || now,
      updatedAt: now,
    };

    if (this.useMongo) {
      try {
        await this.db.collection('tickets').insertOne(ticket);
        return ticket;
      } catch (err) {
        console.error('[Database Service] MongoDB saveTicket error:', err.message);
      }
    }

    try {
      const tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf-8'));
      tickets.push(ticket);
      fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2), 'utf-8');
      return ticket;
    } catch (err) {
      console.error('[Database Service] Local JSON saveTicket error:', err.message);
      return ticket;
    }
  }

  async getAllTickets() {
    if (this.useMongo) {
      try {
        return await this.db.collection('tickets').find({}).sort({ createdAt: -1 }).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getAllTickets error:', err.message);
        return [];
      }
    }
    try {
      return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf-8')).reverse();
    } catch (err) {
      console.error('[Database Service] Local JSON getAllTickets error:', err.message);
      return [];
    }
  }

  /** Update a ticket's status ('open' | 'resolved') — used by the admin console. */
  async updateTicketStatus(id, status) {
    const next = status === 'resolved' ? 'resolved' : 'open';
    const patch = { status: next, updatedAt: new Date().toISOString() };
    if (this.useMongo) {
      try {
        await this.db.collection('tickets').updateOne({ id }, { $set: patch });
        return true;
      } catch (err) {
        console.error('[Database Service] MongoDB updateTicketStatus error:', err.message);
      }
    }
    try {
      const tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf-8'));
      const idx = tickets.findIndex(t => t.id === id);
      if (idx !== -1) { tickets[idx] = { ...tickets[idx], ...patch }; fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2), 'utf-8'); }
      return true;
    } catch (err) {
      console.error('[Database Service] Local JSON updateTicketStatus error:', err.message);
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

  // --- Meta (small key/value store) ---
  //
  // Currently holds only the catch-up watermark, but a generic pair beats another
  // single-purpose file the next time something needs one value persisted.

  async getMeta(key, fallback = null) {
    if (this.useMongo) {
      try {
        const doc = await this.db.collection('meta').findOne({ _id: key });
        return doc ? doc.value : fallback;
      } catch (err) {
        console.error('[Database Service] MongoDB getMeta error:', err.message);
        return fallback;
      }
    }

    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      return key in meta ? meta[key] : fallback;
    } catch (err) {
      console.error('[Database Service] Local JSON getMeta error:', err.message);
      return fallback;
    }
  }

  async setMeta(key, value) {
    if (this.useMongo) {
      try {
        await this.db.collection('meta').updateOne(
          { _id: key },
          { $set: { value, updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB setMeta error:', err.message);
      }
    }

    try {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); } catch { meta = {}; }
      meta[key] = value;
      fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database Service] Local JSON setMeta error:', err.message);
    }
  }

  // --- Catch-up queue (missed customers awaiting a reply) ---

  /**
   * Add missed chats to the queue, skipping any already queued.
   * Deduped on messageId so repeated sweeps (every reconnect) can't queue a customer twice.
   * @returns {number} how many were newly added
   */
  async queueCatchupItems(items) {
    if (!items || !items.length) return 0;

    if (this.useMongo) {
      try {
        const ops = items.map((item) => ({
          updateOne: {
            filter: { _id: item.messageId },
            // $setOnInsert only: a chat already waiting must keep its original queuedAt
            // and attempt count rather than being reset by the next sweep.
            update: { $setOnInsert: { ...item, queuedAt: Date.now(), attempts: 0 } },
            upsert: true,
          },
        }));
        const res = await this.db.collection('catchup_queue').bulkWrite(ops, { ordered: false });
        return res.upsertedCount || 0;
      } catch (err) {
        console.error('[Database Service] MongoDB queueCatchupItems error:', err.message);
        return 0;
      }
    }

    try {
      const queue = JSON.parse(fs.readFileSync(CATCHUP_QUEUE_FILE, 'utf-8'));
      const known = new Set(queue.map((e) => e.messageId));
      let added = 0;
      for (const item of items) {
        if (known.has(item.messageId)) continue;
        queue.push({ ...item, queuedAt: Date.now(), attempts: 0 });
        known.add(item.messageId);
        added++;
      }
      if (added) fs.writeFileSync(CATCHUP_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
      return added;
    } catch (err) {
      console.error('[Database Service] Local JSON queueCatchupItems error:', err.message);
      return 0;
    }
  }

  /**
   * Next items to answer: recent customers (tierRank 0) ahead of old backlog (1), and
   * within each tier the one who has waited longest goes first.
   *
   * Tier must outrank age. A plain oldest-first sort would put a still-waiting customer from
   * an hour ago BEHIND a thousand month-old messages — so a crash mid-sweep would bury the
   * people most likely to still buy.
   */
  async getCatchupBatch(limit = 5) {
    if (this.useMongo) {
      try {
        return await this.db.collection('catchup_queue')
          .find({}).sort({ tierRank: 1, timestamp: 1 }).limit(limit).toArray();
      } catch (err) {
        console.error('[Database Service] MongoDB getCatchupBatch error:', err.message);
        return [];
      }
    }

    try {
      const queue = JSON.parse(fs.readFileSync(CATCHUP_QUEUE_FILE, 'utf-8'));
      return queue
        .sort((a, b) => ((a.tierRank ?? 1) - (b.tierRank ?? 1)) || (a.timestamp - b.timestamp))
        .slice(0, limit);
    } catch (err) {
      console.error('[Database Service] Local JSON getCatchupBatch error:', err.message);
      return [];
    }
  }

  async deleteCatchupItem(messageId) {
    if (this.useMongo) {
      try {
        await this.db.collection('catchup_queue').deleteOne({ _id: messageId });
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB deleteCatchupItem error:', err.message);
      }
    }

    try {
      const queue = JSON.parse(fs.readFileSync(CATCHUP_QUEUE_FILE, 'utf-8'));
      fs.writeFileSync(
        CATCHUP_QUEUE_FILE,
        JSON.stringify(queue.filter((e) => e.messageId !== messageId), null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('[Database Service] Local JSON deleteCatchupItem error:', err.message);
    }
  }

  /**
   * Drop every queued item for a chat. Called as soon as a customer messages LIVE: they are
   * now in a real conversation, so answering their older queued message afterwards would send
   * a second, out-of-context reply to someone the bot is already talking to.
   */
  async deleteCatchupByChat(chatId) {
    if (this.useMongo) {
      try {
        await this.db.collection('catchup_queue').deleteMany({ chatId });
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB deleteCatchupByChat error:', err.message);
      }
    }

    try {
      const queue = JSON.parse(fs.readFileSync(CATCHUP_QUEUE_FILE, 'utf-8'));
      const filtered = queue.filter((e) => e.chatId !== chatId);
      if (filtered.length !== queue.length) {
        fs.writeFileSync(CATCHUP_QUEUE_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
      }
    } catch (err) {
      console.error('[Database Service] Local JSON deleteCatchupByChat error:', err.message);
    }
  }

  /** Record a failed attempt so a permanently-broken item can't block the queue forever. */
  async bumpCatchupAttempt(messageId) {
    if (this.useMongo) {
      try {
        await this.db.collection('catchup_queue').updateOne(
          { _id: messageId }, { $inc: { attempts: 1 } }
        );
        return;
      } catch (err) {
        console.error('[Database Service] MongoDB bumpCatchupAttempt error:', err.message);
      }
    }

    try {
      const queue = JSON.parse(fs.readFileSync(CATCHUP_QUEUE_FILE, 'utf-8'));
      const item = queue.find((e) => e.messageId === messageId);
      if (item) {
        item.attempts = (item.attempts || 0) + 1;
        fs.writeFileSync(CATCHUP_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
      }
    } catch (err) {
      console.error('[Database Service] Local JSON bumpCatchupAttempt error:', err.message);
    }
  }

  async getCatchupStats() {
    if (this.useMongo) {
      try {
        const col = this.db.collection('catchup_queue');
        const pending = await col.countDocuments({});
        const oldest = await col.find({}).sort({ timestamp: 1 }).limit(1).toArray();
        return { pending, oldestTimestamp: oldest[0]?.timestamp || null };
      } catch (err) {
        console.error('[Database Service] MongoDB getCatchupStats error:', err.message);
        return { pending: 0, oldestTimestamp: null };
      }
    }

    try {
      const queue = JSON.parse(fs.readFileSync(CATCHUP_QUEUE_FILE, 'utf-8'));
      const oldest = queue.reduce((min, e) => (min === null || e.timestamp < min ? e.timestamp : min), null);
      return { pending: queue.length, oldestTimestamp: oldest };
    } catch (err) {
      return { pending: 0, oldestTimestamp: null };
    }
  }
}

const dbService = new DatabaseService();
export default dbService;

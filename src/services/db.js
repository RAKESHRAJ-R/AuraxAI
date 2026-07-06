import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');

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
}

const dbService = new DatabaseService();
export default dbService;

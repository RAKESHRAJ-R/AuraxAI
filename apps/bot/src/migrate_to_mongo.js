/**
 * One-time migration: copy existing local JSON data into MongoDB.
 *
 * Usage:
 *   1. Put your Atlas (or local) connection string in .env as MONGODB_URI
 *   2. Run:  npm run migrate-mongo
 *
 * It's idempotent — every record is upserted by its natural key, so running it
 * twice won't create duplicates. The JSON files are left untouched (they remain
 * the automatic fallback if Mongo is ever unreachable).
 *
 * Uses the SAME database name ('theaurax_assistant') and collections as
 * src/services/db.js, so the running bot picks the data up with no further change.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_NAME = 'theaurax_assistant';

function readJson(file, fallback) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.warn(`  ! could not read ${file}: ${err.message}`);
    return fallback;
  }
}

// Upsert an array of docs into a collection, keyed by `keyFn(doc)` → filter object.
async function upsertAll(db, collection, docs, keyFn) {
  if (!docs || docs.length === 0) return { collection, migrated: 0, skipped: 0 };
  let migrated = 0, skipped = 0;
  for (const doc of docs) {
    const filter = keyFn(doc);
    if (!filter || Object.values(filter).some(v => v === undefined || v === null || v === '')) { skipped++; continue; }
    await db.collection(collection).updateOne(filter, { $set: doc }, { upsert: true });
    migrated++;
  }
  return { collection, migrated, skipped };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('\n❌ MONGODB_URI is not set in .env.');
    console.error('   Create a free MongoDB Atlas cluster, copy its connection string,');
    console.error('   and add it to .env as:  MONGODB_URI=mongodb+srv://...\n');
    process.exit(1);
  }

  const { MongoClient } = await import('mongodb');
  console.log('\n🔌 Connecting to MongoDB…');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(`✅ Connected. Migrating into database "${DB_NAME}".\n`);

  // sessions.json is an object keyed by userId → array of session docs
  const sessionsObj = readJson('sessions.json', {});
  const sessions = Object.values(sessionsObj);
  const leads = readJson('leads.json', []);
  const customers = readJson('customers.json', []);
  const knowledge = readJson('knowledge.json', []);
  const retryQueue = readJson('retry_queue.json', []);

  const results = [];
  results.push(await upsertAll(db, 'sessions', sessions, d => ({ userId: d.userId })));
  results.push(await upsertAll(db, 'leads', leads, d => ({ userId: d.userId })));
  results.push(await upsertAll(db, 'customers', customers, d => ({ userId: d.userId })));
  results.push(await upsertAll(db, 'knowledge', knowledge, d => ({ id: d.id })));
  results.push(await upsertAll(db, 'retry_queue', retryQueue, d => ({ senderId: d.senderId, userQuery: d.userQuery })));

  console.log('── Migration summary ─────────────────────────');
  for (const r of results) {
    console.log(`  ${r.collection.padEnd(13)} migrated ${r.migrated}${r.skipped ? `, skipped ${r.skipped} (missing key)` : ''}`);
  }
  console.log('──────────────────────────────────────────────');
  console.log('\n✅ Done. The bot will now use MongoDB automatically (MONGODB_URI is set).');
  console.log('   The JSON files remain as an automatic fallback.\n');

  await client.close();
}

main().catch(err => {
  console.error('\n❌ Migration failed:', err.message);
  console.error('   Check that MONGODB_URI is correct and your IP is allowed in Atlas → Network Access.\n');
  process.exit(1);
});

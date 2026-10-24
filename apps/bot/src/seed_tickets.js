/**
 * Seeds SAMPLE support tickets so the admin console's Tickets page can be checked
 * without waiting for a real customer complaint.
 *
 *   node src/seed_tickets.js            # insert / refresh the samples
 *   node src/seed_tickets.js --remove   # delete them again (cleanup after testing)
 *
 * Writes through dbService, so it lands in MongoDB when MONGODB_URI is set and in
 * src/data/tickets.json otherwise — same store the running bot reads.
 *
 * Every sample uses a fixed SAMPLE-* id, and the script deletes exactly those ids
 * before inserting. Re-running is idempotent and it can never touch a real ticket.
 */
import 'dotenv/config';
import dbService from './services/db.js';

const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

// Covers all 8 issueType values the support agent can emit, both statuses, and the
// with/without photo + with/without order-id branches the table renders differently.
const SAMPLES = [
  {
    id: 'SAMPLE-TKT-001',
    userId: '919843112233@c.us',
    name: 'Priya Raman',
    phone: '919843112233',
    email: 'priya.raman@gmail.com',
    orderId: '10482',
    issueType: 'wrong_item',
    description: 'Ordered Real Madrid home jersey size M, received an Arsenal away jersey instead. Photo of the packet attached.',
    hasPhoto: true,
    status: 'open',
    createdAt: minsAgo(14),
  },
  {
    id: 'SAMPLE-TKT-002',
    userId: '919176554821@c.us',
    name: 'Karthik S',
    phone: '919176554821',
    email: '',
    orderId: '10455',
    issueType: 'damaged',
    description: 'Stitching has come off near the left sleeve and there is a small tear on the club crest. Jersey is unused, tags intact.',
    hasPhoto: true,
    status: 'open',
    createdAt: minsAgo(95),
  },
  {
    id: 'SAMPLE-TKT-003',
    userId: '918220447719@c.us',
    name: 'Divya Nair',
    phone: '918220447719',
    email: 'divya.nair91@outlook.com',
    orderId: '10391',
    issueType: 'missing_package',
    description: 'Tracking shows delivered on 1st Aug but nothing received. Checked with neighbours and building security, no one has it.',
    hasPhoto: false,
    status: 'open',
    createdAt: minsAgo(260),
  },
  {
    id: 'SAMPLE-TKT-004',
    userId: '919994003317@c.us',
    name: 'Mohammed Irfan',
    phone: '919994003317',
    email: '',
    orderId: '10502',
    issueType: 'delayed',
    description: 'Ordered 9 days ago, still not shipped. Needs it before the weekend match — asking for an update or cancellation.',
    hasPhoto: false,
    status: 'open',
    createdAt: minsAgo(610),
  },
  {
    id: 'SAMPLE-TKT-005',
    userId: '917598220145@c.us',
    name: 'Ajay Kumar',
    phone: '917598220145',
    email: 'ajaykumar.mdu@gmail.com',
    orderId: '10370',
    issueType: 'wrong_customization',
    description: 'Custom print says "AJEY 10" instead of "AJAY 7". Name and number both wrong on a customised order.',
    hasPhoto: true,
    status: 'open',
    createdAt: minsAgo(1490),
  },
  {
    id: 'SAMPLE-TKT-006',
    userId: '919025778430@c.us',
    name: 'Sneha Vasanth',
    phone: '919025778430',
    email: '',
    orderId: '10288',
    issueType: 'exchange',
    description: 'Barcelona home jersey size L is too tight, wants to exchange for XL. Within 7 days, unused with tags.',
    hasPhoto: false,
    status: 'resolved',
    createdAt: minsAgo(2880),
  },
  {
    id: 'SAMPLE-TKT-007',
    userId: '918946331204@c.us',
    name: 'Rahul Menon',
    phone: '918946331204',
    email: 'rahul.menon@zohomail.in',
    orderId: '',
    issueType: 'talk_to_human',
    description: 'Wants to speak to a person about a 25-jersey order for a college team — pricing and delivery timeline.',
    hasPhoto: false,
    status: 'open',
    createdAt: minsAgo(4320),
  },
  {
    id: 'SAMPLE-TKT-008',
    userId: '919600812277@c.us',
    name: 'Lakshmi Priya',
    phone: '919600812277',
    email: '',
    orderId: '10201',
    issueType: 'other',
    description: 'Payment debited twice for the same order, asking for one of the charges to be reversed.',
    hasPhoto: false,
    status: 'resolved',
    createdAt: minsAgo(7200),
  },
];

const SAMPLE_IDS = SAMPLES.map((s) => s.id);

async function removeSamples() {
  if (dbService.useMongo) {
    const r = await dbService.db.collection('tickets').deleteMany({ id: { $in: SAMPLE_IDS } });
    return r.deletedCount || 0;
  }
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(process.cwd(), 'src', 'data', 'tickets.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const kept = all.filter((t) => !SAMPLE_IDS.includes(t.id));
  fs.writeFileSync(file, JSON.stringify(kept, null, 2), 'utf-8');
  return all.length - kept.length;
}

(async () => {
  await dbService.ready;
  const store = dbService.useMongo ? 'MongoDB' : 'local JSON (src/data/tickets.json)';
  console.log(`\n[Seed Tickets] Store: ${store}\n`);

  const removed = await removeSamples();
  if (removed) console.log(`  🧹 Removed ${removed} existing sample ticket(s)`);

  if (process.argv.includes('--remove')) {
    console.log('\n✅ Samples removed. Tickets page is back to real data only.\n');
    process.exit(0);
  }

  for (const s of SAMPLES) {
    await dbService.saveTicket(s);
    console.log(`  ✅ ${s.id}  ${s.issueType.padEnd(20)} ${s.status.padEnd(8)} ${s.name}`);
  }

  const open = SAMPLES.filter((s) => s.status === 'open').length;
  console.log(
    `\n${SAMPLES.length} sample tickets inserted — ${open} open, ${SAMPLES.length - open} resolved, ` +
    `${SAMPLES.filter((s) => s.hasPhoto).length} with photos.`
  );
  console.log('Open the admin console → Support Tickets. Run with --remove to clean up.\n');
  process.exit(0);
})();

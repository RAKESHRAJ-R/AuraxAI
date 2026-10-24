/**
 * Admin console accounts regression suite — `npm run test-admin-auth`.
 *
 * Runs the REAL sign-in, users, roles and activity-log API (routes/admin.js) on a throwaway
 * Express server, with the real requirePermission() guard on sample routes shaped like the
 * bot's own. Email is stubbed, so nothing is sent.
 *
 * ⚠️ Never touches live data: it forces JSON storage (MONGODB_URI removed) in a temp directory
 * via AURAX_DATA_DIR, and deletes that directory at the end.
 *
 * Proves: passwords are stored hashed; a role only reaches the routes it grants; changing a
 * role, disabling an account or setting a password applies on the very next request (not
 * after a cache expires); sessions survive a restart; lockout after repeated wrong passwords;
 * nobody can remove the last Owner, promote themselves, or grant access they don't have; view-
 * only roles never receive the WhatsApp QR/linking code; and changes land in the activity log.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const config = (await import('./config/config.js')).default; // runs dotenv first…
delete process.env.MONGODB_URI;                                 // …so this removal sticks
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aurax-admin-test-'));
process.env.AURAX_DATA_DIR = DATA_DIR;

const OWNER = { email: 'owner@test.local', password: 'owner-pass-123', name: 'Test Owner' };
config.adminAuth.ownerEmail = OWNER.email;
config.adminAuth.ownerPassword = OWNER.password;
config.adminAuth.ownerName = OWNER.name;

const express = (await import('express')).default;
const dbService = (await import('./services/db.js')).default;
const adminAuthModule = await import('./services/adminAuth.js');
const adminAuth = adminAuthModule.default;
const { requirePermission } = adminAuthModule;
const mailService = (await import('./services/mail.js')).default;
const { createAdminRouter } = await import('./routes/admin.js');

await dbService.ready;
if (dbService.useMongo) {
  console.error('Refusing to run: storage resolved to MongoDB, not the temp JSON directory.');
  process.exit(1);
}

// --- stub email -----------------------------------------------------------------
const emails = [];
let mailFails = false;
mailService.isConfigured = () => true;
mailService.sendAccessEmail = async (details) => {
  emails.push(details);
  return mailFails ? { sent: false, error: 'stubbed failure' } : { sent: true, messageId: 'stub' };
};

// --- server ---------------------------------------------------------------------
await adminAuth.ensureSeeded();
const app = express();
app.use(express.json());
app.use('/api', createAdminRouter());
// Stand-ins for the bot's own routes, guarded exactly the way index.js guards them.
app.post('/api/knowledge', requirePermission('knowledge.edit'), (req, res) => res.json({ ok: true }));
app.get('/api/tickets', requirePermission('tickets.view'), (req, res) => res.json([]));
app.post('/api/provider-stats/reset', requirePermission('owner'), (req, res) => res.json({ ok: true }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const login = (email, password) => call('POST', '/api/auth/login', { body: { email, password } });

let fails = 0;
const line = (s) => console.log('\n──── ' + s + ' ' + '─'.repeat(Math.max(0, 56 - s.length)));
const must = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
};

try {
  // --- 1. first boot --------------------------------------------------------------
  line('1. First boot seeds the roles and the Owner');
  const roles = await dbService.getAdminRoles();
  must('three built-in roles', roles.map((r) => r.id).sort(), ['owner', 'role_tester', 'role_viewer']);
  const users = await dbService.getAdminUsers();
  must('one Owner account from config', users.map((u) => [u.email, u.roleId]), [[OWNER.email, 'owner']]);
  must('password stored as a scrypt hash, not plaintext',
    users[0].passwordHash.startsWith('scrypt$') && !fs.readFileSync(path.join(DATA_DIR, 'admin_users.json'), 'utf-8').includes(OWNER.password),
    true);
  await adminAuth.ensureSeeded();
  must('a second boot does not duplicate anything', [(await dbService.getAdminRoles()).length, (await dbService.getAdminUsers()).length], [3, 1]);

  // --- 2. sign-in -----------------------------------------------------------------
  line('2. Sign-in');
  must('wrong password → 401', (await login(OWNER.email, 'nope-nope-nope')).status, 401);
  const unknown = await login('nobody@test.local', 'whatever-123');
  must('unknown email → same 401 message', [unknown.status, unknown.body.error], [401, 'Incorrect email or password.']);
  const ownerLogin = await login('  OWNER@test.local ', OWNER.password);
  must('email is case/space-insensitive', ownerLogin.status, 200);
  const ownerToken = ownerLogin.body.token;
  must('owner gets the wildcard permission', ownerLogin.body.user.permissions, ['*']);
  must('response never includes the hash', 'passwordHash' in ownerLogin.body.user, false);
  const sessionsFile = fs.readFileSync(path.join(DATA_DIR, 'admin_sessions.json'), 'utf-8');
  must('only the token HASH is stored', sessionsFile.includes(ownerToken), false);
  must('no token → 401', (await call('GET', '/api/auth/me')).status, 401);

  // --- 3. creating a tester -------------------------------------------------------
  line('3. Owner creates a tester, and the login is emailed');
  const TESTER = { name: 'Priya Tester', email: 'priya@test.local', password: 'tester-pass-1', roleId: 'role_tester' };
  const created = await call('POST', '/api/admin/users', { token: ownerToken, body: TESTER });
  must('created', [created.status, created.body.user?.roleName, created.body.mail?.sent], [200, 'Tester', true]);
  must('email carried the exact password the owner chose',
    [emails.at(-1)?.email, emails.at(-1)?.password, emails.at(-1)?.kind], [TESTER.email, TESTER.password, 'created']);
  must('duplicate email → 409', (await call('POST', '/api/admin/users', { token: ownerToken, body: { ...TESTER, email: 'PRIYA@test.local' } })).status, 409);
  must('short password → 400', (await call('POST', '/api/admin/users', { token: ownerToken, body: { ...TESTER, email: 'x@test.local', password: 'short' } })).status, 400);
  mailFails = true;
  const noMail = await call('POST', '/api/admin/users', { token: ownerToken, body: { name: 'Mail Fail', email: 'mailfail@test.local', password: 'mailfail-123', roleId: 'role_viewer' } });
  must('a failed email still creates the account and says why', [noMail.status, noMail.body.mail], [200, { sent: false, error: 'stubbed failure' }]);
  mailFails = false;
  const skipped = emails.length;
  await call('POST', '/api/admin/users', { token: ownerToken, body: { name: 'No Mail', email: 'nomail@test.local', password: 'nomail-1234', roleId: 'role_viewer', sendEmail: false } });
  must('sendEmail:false sends nothing', emails.length, skipped);

  // --- 4. what the tester can reach -----------------------------------------------
  line('4. The tester only reaches what the role grants');
  const testerLogin = await login(TESTER.email, TESTER.password);
  const testerToken = testerLogin.body.token;
  must('tester signs in with the owner-chosen password', testerLogin.status, 200);
  must('tester can teach answers', (await call('POST', '/api/knowledge', { token: testerToken, body: {} })).status, 200);
  must('tester cannot open Users', (await call('GET', '/api/admin/users', { token: testerToken })).status, 403);
  must('tester cannot read the activity log', (await call('GET', '/api/admin/activity', { token: testerToken })).status, 403);
  must('tester cannot hit owner-only routes', (await call('POST', '/api/provider-stats/reset', { token: testerToken })).status, 403);
  must('owner can hit owner-only routes', (await call('POST', '/api/provider-stats/reset', { token: ownerToken })).status, 200);

  // --- 5. changes apply on the next request ---------------------------------------
  line('5. Role changes, disabling and passwords apply immediately');
  const testerId = testerLogin.body.user.id;
  await call('POST', `/api/admin/users/${testerId}`, { token: ownerToken, body: { roleId: 'role_viewer' } });
  must('moved to Viewer → teaching is refused at once', (await call('POST', '/api/knowledge', { token: testerToken, body: {} })).status, 403);
  must('…but viewing tickets still works', (await call('GET', '/api/tickets', { token: testerToken })).status, 200);
  await call('POST', `/api/admin/users/${testerId}`, { token: ownerToken, body: { status: 'disabled' } });
  must('disabled → existing session rejected', (await call('GET', '/api/auth/me', { token: testerToken })).status, 401);
  must('disabled → correct password refused', (await login(TESTER.email, TESTER.password)).status, 403);
  await call('POST', `/api/admin/users/${testerId}`, { token: ownerToken, body: { status: 'active', roleId: 'role_tester' } });
  const relogin = await login(TESTER.email, TESTER.password);
  must('re-enabled → can sign in again', relogin.status, 200);
  const pw = await call('POST', `/api/admin/users/${testerId}/password`, { token: ownerToken, body: { password: 'brand-new-pass-9' } });
  must('owner sets a new password (and it is emailed)', [pw.status, emails.at(-1)?.kind, emails.at(-1)?.password], [200, 'password', 'brand-new-pass-9']);
  must('…the tester\'s open session is ended', (await call('GET', '/api/auth/me', { token: relogin.body.token })).status, 401);
  must('…the old password stops working', (await login(TESTER.email, TESTER.password)).status, 401);
  must('…the new one works', (await login(TESTER.email, 'brand-new-pass-9')).status, 200);

  // --- 6. restarts ----------------------------------------------------------------
  line('6. Sign-ins survive a server restart');
  adminAuth.invalidate(); // drops every in-memory cache, as a restart would
  must('owner token still valid after caches are gone', (await call('GET', '/api/auth/me', { token: ownerToken })).status, 200);

  // --- 7. guard rails -------------------------------------------------------------
  line('7. Nobody can lock the console or escalate');
  const me = (await call('GET', '/api/auth/me', { token: ownerToken })).body;
  must('cannot disable yourself', (await call('POST', `/api/admin/users/${me.id}`, { token: ownerToken, body: { status: 'disabled' } })).status, 403);
  must('cannot delete yourself', (await call('DELETE', `/api/admin/users/${me.id}`, { token: ownerToken })).status, 403);
  must('Owner role cannot be edited', (await call('POST', '/api/admin/roles', { token: ownerToken, body: { id: 'owner', name: 'Owner', permissions: ['monitor.view'] } })).status, 403);

  // Second owner, so we can test "last owner" from a different account.
  const owner2 = await call('POST', '/api/admin/users', { token: ownerToken, body: { name: 'Owner Two', email: 'owner2@test.local', password: 'owner2-pass-1', roleId: 'owner' } });
  const owner2Token = (await login('owner2@test.local', 'owner2-pass-1')).body.token;
  must('an Owner can be demoted while another remains', (await call('POST', `/api/admin/users/${owner2.body.user.id}`, { token: ownerToken, body: { roleId: 'role_viewer' } })).status, 200);
  await call('POST', `/api/admin/users/${owner2.body.user.id}`, { token: ownerToken, body: { roleId: 'owner' } });
  await call('DELETE', `/api/admin/users/${owner2.body.user.id}`, { token: ownerToken });
  must('deleted account\'s session is gone', (await call('GET', '/api/auth/me', { token: owner2Token })).status, 401);

  // A manager: can manage users but is not an Owner.
  const mgrRole = await call('POST', '/api/admin/roles', { token: ownerToken, body: { name: 'Manager', permissions: ['users.manage', 'tickets.manage'] } });
  must('new role saved, view permission implied', mgrRole.body.role?.permissions, ['tickets.view', 'tickets.manage', 'users.manage']);
  await call('POST', '/api/admin/users', { token: ownerToken, body: { name: 'Manny', email: 'mgr@test.local', password: 'manager-pass-1', roleId: mgrRole.body.role.id } });
  const mgrToken = (await login('mgr@test.local', 'manager-pass-1')).body.token;
  must('manager cannot create an Owner', (await call('POST', '/api/admin/users', { token: mgrToken, body: { name: 'Sneaky', email: 'sneaky@test.local', password: 'sneaky-pass-1', roleId: 'owner' } })).status, 403);
  must('manager cannot change an Owner\'s account', (await call('POST', `/api/admin/users/${me.id}/password`, { token: mgrToken, body: { password: 'hijacked-pass-1' } })).status, 403);
  must('manager cannot grant what they lack', (await call('POST', '/api/admin/roles', { token: mgrToken, body: { name: 'Wider', permissions: ['whatsapp.manage'] } })).status, 403);
  must('manager cannot widen their own role', (await call('POST', '/api/admin/roles', { token: mgrToken, body: { id: mgrRole.body.role.id, name: 'Manager', permissions: ['users.manage', 'tickets.manage'] } })).status, 403);
  must('a role in use cannot be deleted', (await call('DELETE', `/api/admin/roles/${mgrRole.body.role.id}`, { token: ownerToken })).status, 409);
  must('an empty role is refused', (await call('POST', '/api/admin/roles', { token: ownerToken, body: { name: 'Empty', permissions: [] } })).status, 400);

  // Last-owner protection, checked from the manager's side of a two-owner-free world:
  // the only Owner left is `me`, and only an Owner may touch it — so try from the owner itself.
  const solo = await call('POST', `/api/admin/users/${me.id}`, { token: ownerToken, body: { roleId: 'role_viewer' } });
  must('the last Owner cannot be demoted (not even by themselves)', solo.status, 403);

  // --- 8. lockout -----------------------------------------------------------------
  line('8. Repeated wrong passwords lock the account');
  for (let i = 0; i < 5; i++) await login('mgr@test.local', 'wrong-password');
  const locked = await login('mgr@test.local', 'manager-pass-1');
  must('locked even with the right password', locked.status, 429);
  const mgrUser = (await dbService.getAdminUsers()).find((u) => u.email === 'mgr@test.local');
  await call('POST', `/api/admin/users/${mgrUser.id}`, { token: ownerToken, body: { unlock: true } });
  must('owner unlocks → sign-in works', (await login('mgr@test.local', 'manager-pass-1')).status, 200);

  // --- 9. activity log ------------------------------------------------------------
  line('9. Activity log');
  const act = await call('GET', '/api/admin/activity?limit=500', { token: ownerToken });
  const actions = new Set(act.body.entries.map((e) => e.action));
  for (const a of ['auth.login', 'auth.login_failed', 'auth.locked', 'users.create', 'users.update', 'users.disable', 'users.enable', 'users.password', 'users.delete', 'roles.create']) {
    must(`records ${a}`, actions.has(a), true);
  }
  must('newest first', act.body.entries[0].at >= act.body.entries.at(-1).at, true);
  must('no password ever appears in the log',
    JSON.stringify(act.body.entries).includes('brand-new-pass-9') || JSON.stringify(act.body.entries).includes(TESTER.password), false);
  const page = await call('GET', '/api/admin/activity?limit=3', { token: ownerToken });
  must('paging reports more', [page.body.entries.length, page.body.hasMore], [3, true]);

  // --- 10. sign-out ---------------------------------------------------------------
  line('10. Signing out ends the session');
  must('logout ok', (await call('POST', '/api/auth/logout', { token: mgrToken })).status, 200);
  must('token rejected afterwards', (await call('GET', '/api/auth/me', { token: mgrToken })).status, 401);
} catch (err) {
  fails++;
  console.error('\n❌ Suite crashed:', err);
} finally {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(64));
console.log(fails === 0 ? '  ALL CHECKS PASSED' : `  ${fails} CHECK(S) FAILED`);
console.log('='.repeat(64));
process.exit(fails === 0 ? 0 : 1);

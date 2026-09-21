/**
 * Create or recover an Owner account for the admin console, from the server's shell.
 *
 * There is no "forgot password" link in the console, so this is the way back in when the only
 * Owner has lost their password or locked themselves out. It uses the same storage as the
 * running bot (MongoDB when MONGODB_URI is set, the JSON files otherwise).
 *
 *   npm run admin-user -- --email owner@theaurax.in --password "new-password" [--name "Owner Name"]
 *
 * Existing email → sets the new password, makes the account an active Owner, clears any
 *                  lockout, and signs it out everywhere.
 * New email      → creates an active Owner account.
 *
 * The running server picks the change up within a minute; no restart is needed.
 */
import dbService from './services/db.js';
import adminAuth, { hashPassword, passwordProblem, OWNER_ROLE_ID } from './services/adminAuth.js';
import crypto from 'crypto';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = String(arg('email') || '').trim().toLowerCase();
  const password = arg('password');
  const name = arg('name');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
    console.error('Usage: npm run admin-user -- --email you@example.com --password "new-password" [--name "Your Name"]');
    process.exit(1);
  }
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  await dbService.ready;
  await adminAuth.ensureSeeded();

  const now = new Date().toISOString();
  const existing = (await dbService.getAdminUsers()).find((u) => u.email === email);
  if (existing) {
    await dbService.saveAdminUser({
      ...existing,
      name: name || existing.name,
      passwordHash: await hashPassword(password),
      roleId: OWNER_ROLE_ID,
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: now,
    });
    await dbService.deleteAdminSessions({ userId: existing.id });
    console.log(`✅ ${email} is now an active Owner with the new password. Existing sign-ins were ended.`);
  } else {
    await dbService.saveAdminUser({
      id: `usr_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
      name: name || 'Store Owner',
      email,
      passwordHash: await hashPassword(password),
      roleId: OWNER_ROLE_ID,
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      createdBy: 'setup',
      updatedAt: now,
    });
    console.log(`✅ Created an Owner account for ${email}.`);
  }
  await dbService.appendAdminActivity({
    id: `act_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
    at: now,
    userId: null,
    userName: 'Server command line',
    userEmail: null,
    roleName: null,
    action: 'users.recover',
    summary: `${existing ? 'Reset the password for' : 'Created'} the Owner account ${email} from the server command line`,
    ip: 'server',
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
  });

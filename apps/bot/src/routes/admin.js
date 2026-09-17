import express from 'express';
import adminAuth, { requirePermission, AdminError, PAGES, PERMISSIONS, OWNER_ROLE_ID, clientIp } from '../services/adminAuth.js';
import mailService from '../services/mail.js';
import dbService from '../services/db.js';

/**
 * Admin console account API: sign-in, users, roles and the activity log. Mounted at /api.
 * Kept out of index.js so it can be exercised on its own (src/test_admin_auth.js) without
 * booting WhatsApp, the scheduler and the rest of the bot.
 */

// Wrap a handler so AdminErrors become their status + message, and anything else a 500.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message });
    console.error(`[Admin API] ${req.method} ${req.path} failed:`, err.message);
    return res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
  }
};

// Per-IP ceiling on sign-in attempts, on top of the per-account lockout. Stops one client
// cycling through many emails. In-memory is enough: this is a single-process server.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_IP = 30;
const loginAttempts = new Map(); // ip -> { count, resetAt }

function loginRateLimited(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    if (loginAttempts.size > 5000) loginAttempts.clear();
    entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_PER_IP;
}

async function emailAccess(req, user, password, roleName, kind) {
  return mailService.sendAccessEmail({
    name: user.name,
    email: user.email,
    password,
    roleName,
    sentBy: req.admin.user.name,
    kind,
  });
}

const emailNote = (mail) => (mail.sent ? 'login details emailed' : `email not sent: ${mail.error}`);

export function createAdminRouter() {
  const router = express.Router();

  // ── Sign-in ──

  router.post('/auth/login', handle(async (req, res) => {
    if (loginRateLimited(clientIp(req))) {
      return res.status(429).json({ error: 'Too many sign-in attempts from this network. Wait 15 minutes and try again.' });
    }
    const email = String(req.body?.email || '').slice(0, 254);
    try {
      const { token, ctx } = await adminAuth.login(email, req.body?.password);
      req.admin = ctx;
      await adminAuth.record(req, 'auth.login', 'Signed in');
      res.json({ token, user: adminAuth.me(ctx) });
    } catch (err) {
      if (err instanceof AdminError && err.status === 401) {
        // The account's owner is recorded as the subject so the log shows whose account was tried.
        await adminAuth.record(
          req,
          err.locked ? 'auth.locked' : 'auth.login_failed',
          err.locked
            ? `Account locked after too many wrong passwords (${email})`
            : `Wrong password for ${email || '(no email)'}`,
          err.user ? { id: err.user.id, name: err.user.name, email: err.user.email } : { email },
        );
      }
      throw err;
    }
  }));

  router.get('/auth/me', requirePermission(), (req, res) => {
    res.json(adminAuth.me(req.admin));
  });

  router.post('/auth/logout', requirePermission(), handle(async (req, res) => {
    await adminAuth.logout(req.admin);
    await adminAuth.record(req, 'auth.logout', 'Signed out');
    res.json({ ok: true });
  }));

  // ── Users ──

  router.get('/admin/users', requirePermission('users.manage'), handle(async (req, res) => {
    const [users, roles] = await Promise.all([adminAuth.listUsers(), adminAuth.listRoles()]);
    res.json({ users, roles, mail: { configured: mailService.isConfigured() } });
  }));

  router.post('/admin/users', requirePermission('users.manage'), handle(async (req, res) => {
    const body = req.body || {};
    const { user, role } = await adminAuth.createUser(req.admin, body);
    const mail = body.sendEmail === false
      ? { sent: false, skipped: true }
      : await emailAccess(req, user, body.password, role.name, 'created');
    await adminAuth.record(
      req, 'users.create',
      `Added ${user.name} (${user.email}) as ${role.name}${mail.skipped ? '' : ` — ${emailNote(mail)}`}`,
    );
    res.json({ user, mail });
  }));

  router.post('/admin/users/:id', requirePermission('users.manage'), handle(async (req, res) => {
    const { before, user } = await adminAuth.updateUser(req.admin, req.params.id, req.body || {});
    const changes = [];
    if (before.name !== user.name) changes.push(`name → ${user.name}`);
    if (before.email !== user.email) changes.push(`email → ${user.email}`);
    if (before.roleId !== user.roleId) changes.push(`role → ${user.roleName}`);
    if (before.status !== user.status) changes.push(user.status === 'active' ? 'enabled the account' : 'disabled the account');
    if (req.body?.unlock) changes.push('unlocked the account');
    if (changes.length) {
      const action = before.status !== user.status ? (user.status === 'active' ? 'users.enable' : 'users.disable') : 'users.update';
      await adminAuth.record(req, action, `Updated ${before.name} (${before.email}): ${changes.join(', ')}`);
    }
    res.json({ user });
  }));

  router.post('/admin/users/:id/password', requirePermission('users.manage'), handle(async (req, res) => {
    const body = req.body || {};
    const { user, role } = await adminAuth.setPassword(req.admin, req.params.id, body.password);
    const mail = body.sendEmail === false
      ? { sent: false, skipped: true }
      : await emailAccess(req, user, body.password, role?.name || user.roleName, 'password');
    await adminAuth.record(
      req, 'users.password',
      `Set a new password for ${user.name} (${user.email})${mail.skipped ? '' : ` — ${emailNote(mail)}`}`,
    );
    res.json({ user, mail });
  }));

  router.delete('/admin/users/:id', requirePermission('users.manage'), handle(async (req, res) => {
    const removed = await adminAuth.deleteUser(req.admin, req.params.id);
    await adminAuth.record(req, 'users.delete', `Deleted the account for ${removed.name} (${removed.email})`);
    res.json({ ok: true });
  }));

  // ── Roles ──

  router.get('/admin/roles', requirePermission('users.manage'), handle(async (req, res) => {
    res.json({ roles: await adminAuth.listRoles(), pages: PAGES, permissions: PERMISSIONS, ownerRoleId: OWNER_ROLE_ID });
  }));

  router.post('/admin/roles', requirePermission('users.manage'), handle(async (req, res) => {
    const { before, role } = await adminAuth.saveRole(req.admin, req.body || {});
    const label = (keys) => keys.map((k) => PERMISSIONS.find((p) => p.key === k)?.label || k).join(', ');
    if (!before) {
      await adminAuth.record(req, 'roles.create', `Created role ${role.name}: ${label(role.permissions)}`);
    } else {
      const added = role.permissions.filter((p) => !before.permissions.includes(p));
      const removed = before.permissions.filter((p) => !role.permissions.includes(p));
      const parts = [];
      if (before.name !== role.name) parts.push(`renamed from ${before.name}`);
      if (added.length) parts.push(`allowed ${label(added)}`);
      if (removed.length) parts.push(`removed ${label(removed)}`);
      if (before.description !== role.description) parts.push('changed the description');
      if (parts.length) await adminAuth.record(req, 'roles.update', `Updated role ${role.name}: ${parts.join('; ')}`);
    }
    res.json({ role });
  }));

  router.delete('/admin/roles/:id', requirePermission('users.manage'), handle(async (req, res) => {
    const role = await adminAuth.deleteRole(req.admin, req.params.id);
    await adminAuth.record(req, 'roles.delete', `Deleted role ${role.name}`);
    res.json({ ok: true });
  }));

  // ── Activity log ──

  router.get('/admin/activity', requirePermission('activity.view'), handle(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    // Fetch one extra to know whether there is another page, without a count query.
    const rows = await dbService.getAdminActivity({ limit: limit + 1, before });
    res.json({ entries: rows.slice(0, limit), hasMore: rows.length > limit });
  }));

  return router;
}

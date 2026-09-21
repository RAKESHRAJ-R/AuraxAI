import crypto from 'crypto';
import { promisify } from 'util';
import config from '../config/config.js';
import dbService from './db.js';

/**
 * Admin console accounts, roles and permissions.
 *
 * Replaces the old shared team passwords: each person has their own login, and a role
 * decides which pages they can open and what they can change there. Everything is enforced
 * HERE, on the server — the console hiding a page is only cosmetic, since anyone holding a
 * token can call the API directly.
 */

const scrypt = promisify(crypto.scrypt);

// ── Permission catalog ───────────────────────────────────────────────────────────────
// Each page has one permission that grants access to it (`viewPermission`); anything else
// on the page implies that one, so a role can never be "allowed to edit" a page it can't open.

export const PAGES = [
  { id: 'monitor', label: 'Monitor', viewPermission: 'monitor.view' },
  { id: 'whatsapp', label: 'WhatsApp', viewPermission: 'whatsapp.view' },
  { id: 'knowledge', label: 'Knowledge Hub', viewPermission: 'knowledge.view' },
  { id: 'tickets', label: 'Support Tickets', viewPermission: 'tickets.view' },
  { id: 'users', label: 'Users & Roles', viewPermission: 'users.manage' },
  { id: 'activity', label: 'Activity Log', viewPermission: 'activity.view' },
];

export const PERMISSIONS = [
  { key: 'monitor.view', page: 'monitor', label: 'Open the dashboard', description: 'API usage, provider health, live customer chats and server logs.' },
  { key: 'whatsapp.view', page: 'whatsapp', label: 'See the connection', description: 'Connection status and which number is linked.' },
  { key: 'whatsapp.manage', page: 'whatsapp', label: 'Link or unlink the number', description: 'Log the bot out, scan a QR or link by phone number. The bot stops replying to customers until it is linked again.', danger: true },
  { key: 'knowledge.view', page: 'knowledge', label: 'See knowledge', description: 'Saved answers, knowledge sources and flagged conversations.' },
  { key: 'knowledge.edit', page: 'knowledge', label: 'Teach answers', description: 'Add, edit, delete and dismiss answers. Changes reach customers immediately.' },
  { key: 'knowledge.sources', page: 'knowledge', label: 'Manage sources', description: 'Upload documents, crawl websites, and turn sources on or off.' },
  { key: 'tickets.view', page: 'tickets', label: 'See tickets', description: 'Support tickets raised by customers.' },
  { key: 'tickets.manage', page: 'tickets', label: 'Resolve and reopen tickets', description: 'Change a ticket\'s status.' },
  { key: 'users.manage', page: 'users', label: 'Manage users and roles', description: 'Create accounts, set passwords and decide what each role can do.', danger: true },
  { key: 'activity.view', page: 'activity', label: 'See the activity log', description: 'Who changed what in the console, and when.' },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

export const OWNER_ROLE_ID = 'owner';

const SEED_ROLES = [
  {
    id: OWNER_ROLE_ID,
    name: 'Owner',
    description: 'Full access to everything, including users and roles. Cannot be changed.',
    permissions: ['*'],
    system: true,
  },
  {
    id: 'role_tester',
    name: 'Tester',
    description: 'Tests the bot: sees the dashboard and tickets, and can teach answers. Cannot touch the WhatsApp link or users.',
    permissions: ['monitor.view', 'whatsapp.view', 'knowledge.view', 'knowledge.edit', 'tickets.view', 'tickets.manage'],
  },
  {
    id: 'role_viewer',
    name: 'Viewer',
    description: 'Read-only access to the dashboard, knowledge and tickets.',
    permissions: ['monitor.view', 'whatsapp.view', 'knowledge.view', 'tickets.view'],
  },
];

/** Drop unknown keys and add each page's view permission wherever something on that page is granted. */
export function normalizePermissions(list) {
  const out = new Set();
  for (const key of Array.isArray(list) ? list : []) {
    if (!PERMISSION_KEYS.has(key)) continue;
    out.add(key);
    const page = PAGES.find((p) => p.id === key.split('.')[0]);
    if (page) out.add(page.viewPermission);
  }
  // Catalog order, so stored roles and the UI read consistently.
  return PERMISSIONS.map((p) => p.key).filter((k) => out.has(k));
}

/** 'owner' is a pseudo-permission only the Owner role's wildcard satisfies. */
export function hasPermission(permissions, key) {
  if (!Array.isArray(permissions)) return false;
  if (permissions.includes('*')) return true;
  return key !== 'owner' && permissions.includes(key);
}

// ── Passwords ─────────────────────────────────────────────────────────────────────────
// scrypt from Node's own crypto — no bcrypt dependency. The parameters are stored in the
// hash string so they can be raised later without invalidating existing passwords.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(String(password ?? ''), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD_LENGTH = 8;

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 128) return 'Password must be 128 characters or fewer.';
  if (password.trim() !== password) return 'Password can\'t start or end with a space.';
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();

/** An error whose message is safe to show the person using the console. */
export class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

export function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket?.remoteAddress || '').trim().slice(0, 64);
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const SESSION_CACHE_MS = 15 * 1000;
// Safety net for writes made outside this process (the `npm run admin-user` CLI).
const DIRECTORY_CACHE_MS = 60 * 1000;

class AdminAuthService {
  constructor() {
    this.sessionCache = new Map(); // sha256(token) -> { at, ctx }
    this.users = null;
    this.roles = null;
    this.loadedAt = 0;
    this.dummyHash = null;
  }

  /** Drop every cache. Called after any account, role or session change so it applies on the very next request. */
  invalidate() {
    this.sessionCache.clear();
    this.users = null;
    this.roles = null;
  }

  async directory() {
    if (!this.users || !this.roles || Date.now() - this.loadedAt > DIRECTORY_CACHE_MS) {
      const [users, roles] = await Promise.all([dbService.getAdminUsers(), dbService.getAdminRoles()]);
      this.users = users;
      this.roles = roles;
      this.loadedAt = Date.now();
    }
    return { users: this.users, roles: this.roles };
  }

  // ── Boot ──

  /**
   * Seed the built-in roles on an empty store, guarantee the Owner role exists, and create
   * the first Owner account from .env when there are no accounts at all.
   */
  async ensureSeeded() {
    const now = new Date().toISOString();
    const roles = await dbService.getAdminRoles();
    if (roles.length === 0) {
      for (const role of SEED_ROLES) await dbService.saveAdminRole({ ...role, createdAt: now, updatedAt: now });
      console.log('[Admin Auth] Created the built-in roles: Owner, Tester, Viewer.');
    } else if (!roles.some((r) => r.id === OWNER_ROLE_ID)) {
      await dbService.saveAdminRole({ ...SEED_ROLES[0], createdAt: now, updatedAt: now });
    }

    const users = await dbService.getAdminUsers();
    if (users.length === 0) {
      const { ownerEmail, ownerName, ownerPassword } = config.adminAuth;
      if (ownerEmail && ownerPassword && EMAIL_RE.test(ownerEmail)) {
        await dbService.saveAdminUser({
          id: newId('usr'),
          name: ownerName || 'Store Owner',
          email: ownerEmail,
          passwordHash: await hashPassword(ownerPassword),
          roleId: OWNER_ROLE_ID,
          status: 'active',
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: null,
          createdAt: now,
          createdBy: 'setup',
          updatedAt: now,
        });
        console.log(`[Admin Auth] Created the Owner account for ${ownerEmail} from ADMIN_OWNER_EMAIL.`);
      } else {
        console.warn('[Admin Auth] ⚠️  No admin accounts exist, so nobody can sign in to the console. Set ADMIN_OWNER_EMAIL and ADMIN_OWNER_PASSWORD in .env and restart, or run `npm run admin-user`.');
      }
    }

    if (config.legacyAdminPasswords.testing) {
      console.warn('[Admin Auth] TESTING_TEAM_PASSWORD is no longer used — testers need their own account (Users & Roles page).');
    }

    await dbService.purgeExpiredAdminSessions();
    this.invalidate();
  }

  // ── Sign-in and sessions ──

  async login(email, password) {
    const addr = normEmail(email);
    if (!addr || !password) throw new AdminError(400, 'Enter your email and password.');

    const { users } = await this.directory();
    const user = users.find((u) => u.email === addr);

    if (user?.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      const mins = Math.ceil((Date.parse(user.lockedUntil) - Date.now()) / 60000);
      throw new AdminError(429, `Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`);
    }

    // Always run scrypt, even for an unknown email, so response time doesn't reveal which
    // emails have accounts.
    if (!this.dummyHash) this.dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
    const ok = await verifyPassword(password, user ? user.passwordHash : this.dummyHash);

    if (!user || !ok) {
      let locked = false;
      if (user) {
        const failedAttempts = (user.failedAttempts || 0) + 1;
        locked = failedAttempts >= MAX_FAILED_LOGINS;
        await dbService.saveAdminUser({
          ...user,
          failedAttempts: locked ? 0 : failedAttempts,
          lockedUntil: locked ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : user.lockedUntil || null,
        });
        this.invalidate();
      }
      const err = new AdminError(401, 'Incorrect email or password.');
      err.user = user || null;
      err.locked = locked;
      throw err;
    }

    if (user.status !== 'active') {
      throw new AdminError(403, 'This account has been disabled. Contact the store owner.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    await dbService.saveAdminSession({
      id: sha256(token),
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.adminAuth.sessionTtlHours * 3600 * 1000).toISOString(),
    });
    const updated = { ...user, failedAttempts: 0, lockedUntil: null, lastLoginAt: now.toISOString() };
    await dbService.saveAdminUser(updated);
    this.invalidate();

    const ctx = await this.authenticate(token);
    return { token, ctx };
  }

  /**
   * Resolve a bearer token to { user, role, permissions, sessionId, isOwner, can() }, or null.
   * Cached briefly — the console polls several endpoints every few seconds — and the cache is
   * cleared on every account change, so disabling someone takes effect on their next request.
   */
  async authenticate(token) {
    if (!token || typeof token !== 'string' || token.length > 128) return null;
    const sessionId = sha256(token);

    const hit = this.sessionCache.get(sessionId);
    if (hit && Date.now() - hit.at < SESSION_CACHE_MS && (!hit.ctx || Date.parse(hit.ctx.expiresAt) > Date.now())) {
      return hit.ctx;
    }

    let ctx = null;
    const session = await dbService.getAdminSession(sessionId);
    if (session && Date.parse(session.expiresAt) > Date.now()) {
      const { users, roles } = await this.directory();
      const user = users.find((u) => u.id === session.userId);
      if (user && user.status === 'active') {
        const role = roles.find((r) => r.id === user.roleId) || null;
        const permissions = role ? role.permissions : [];
        ctx = {
          user,
          role,
          permissions,
          sessionId,
          expiresAt: session.expiresAt,
          isOwner: hasPermission(permissions, 'owner'),
          can: (key) => hasPermission(permissions, key),
        };
      }
    }

    if (this.sessionCache.size > 1000) this.sessionCache.clear();
    this.sessionCache.set(sessionId, { at: Date.now(), ctx });
    return ctx;
  }

  async logout(ctx) {
    await dbService.deleteAdminSessions({ id: ctx.sessionId });
    this.invalidate();
  }

  // ── Shapes returned to the console (never includes the password hash) ──

  publicUser(user, roles, users = []) {
    const role = roles.find((r) => r.id === user.roleId);
    const creator = users.find((u) => u.id === user.createdBy);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      roleId: user.roleId,
      roleName: role ? role.name : 'No role',
      status: user.status,
      locked: !!(user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()),
      lastLoginAt: user.lastLoginAt || null,
      createdAt: user.createdAt,
      createdBy: creator ? creator.name : user.createdBy === 'setup' ? 'Initial setup' : null,
    };
  }

  me(ctx) {
    return {
      ...this.publicUser(ctx.user, ctx.role ? [ctx.role] : []),
      permissions: ctx.permissions,
      isOwner: ctx.isOwner,
    };
  }

  async listUsers() {
    const { users, roles } = await this.directory();
    return users
      .map((u) => this.publicUser(u, roles, users))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async listRoles() {
    const { users, roles } = await this.directory();
    return roles
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        permissions: r.permissions,
        system: !!r.system,
        userCount: users.filter((u) => u.roleId === r.id).length,
      }))
      // Owner first, then the rest in creation order.
      .sort((a, b) => (b.system - a.system) || 0);
  }

  // ── Users ──

  async _cleanUserFields({ name, email }, users, selfId = null) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new AdminError(400, 'Enter the person\'s name.');
    if (cleanName.length > 80) throw new AdminError(400, 'Name must be 80 characters or fewer.');
    const addr = normEmail(email);
    if (!EMAIL_RE.test(addr) || addr.length > 254) throw new AdminError(400, 'Enter a valid email address.');
    if (users.some((u) => u.email === addr && u.id !== selfId)) {
      throw new AdminError(409, 'Someone already has an account with that email.');
    }
    return { name: cleanName, email: addr };
  }

  _requireRole(roles, roleId, actor) {
    const role = roles.find((r) => r.id === roleId);
    if (!role) throw new AdminError(400, 'Choose a role.');
    if (role.id === OWNER_ROLE_ID && !actor.isOwner) {
      throw new AdminError(403, 'Only an Owner can give someone the Owner role.');
    }
    return role;
  }

  _requireManageable(target, actor) {
    if (!target) throw new AdminError(404, 'That user no longer exists.');
    if (target.roleId === OWNER_ROLE_ID && !actor.isOwner) {
      throw new AdminError(403, 'Only an Owner can change an Owner\'s account.');
    }
  }

  _assertOwnerRemains(users, target, nextRoleId, nextStatus) {
    const wasActiveOwner = target.roleId === OWNER_ROLE_ID && target.status === 'active';
    const staysActiveOwner = nextRoleId === OWNER_ROLE_ID && nextStatus === 'active';
    if (!wasActiveOwner || staysActiveOwner) return;
    const activeOwners = users.filter((u) => u.roleId === OWNER_ROLE_ID && u.status === 'active');
    if (activeOwners.length <= 1) {
      throw new AdminError(409, 'This is the only active Owner. Make someone else an Owner first, or nobody could manage the console.');
    }
  }

  async createUser(actor, body) {
    const { users, roles } = await this.directory();
    const fields = await this._cleanUserFields(body, users);
    const role = this._requireRole(roles, body.roleId, actor);
    const problem = passwordProblem(body.password);
    if (problem) throw new AdminError(400, problem);

    const now = new Date().toISOString();
    const user = {
      id: newId('usr'),
      ...fields,
      passwordHash: await hashPassword(body.password),
      roleId: role.id,
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      createdBy: actor.user.id,
      updatedAt: now,
    };
    await dbService.saveAdminUser(user);
    this.invalidate();
    return { user: this.publicUser(user, roles, users), role };
  }

  async updateUser(actor, id, body) {
    const { users, roles } = await this.directory();
    const target = users.find((u) => u.id === id);
    this._requireManageable(target, actor);
    const self = target.id === actor.user.id;

    const fields = await this._cleanUserFields(
      { name: body.name ?? target.name, email: body.email ?? target.email }, users, target.id
    );
    const roleId = body.roleId ?? target.roleId;
    const status = body.status ?? target.status;
    if (!['active', 'disabled'].includes(status)) throw new AdminError(400, 'Unknown status.');
    if (roleId !== target.roleId) {
      if (self) throw new AdminError(403, 'You can\'t change your own role.');
      this._requireRole(roles, roleId, actor);
    }
    if (status !== target.status && self) throw new AdminError(403, 'You can\'t disable your own account.');
    this._assertOwnerRemains(users, target, roleId, status);

    const updated = {
      ...target,
      ...fields,
      roleId,
      status,
      // Re-enabling someone also clears a lockout, which is what the owner almost always wants.
      ...(status === 'active' && target.status !== 'active' ? { failedAttempts: 0, lockedUntil: null } : {}),
      ...(body.unlock ? { failedAttempts: 0, lockedUntil: null } : {}),
      updatedAt: new Date().toISOString(),
    };
    await dbService.saveAdminUser(updated);
    if (status === 'disabled') await dbService.deleteAdminSessions({ userId: target.id });
    this.invalidate();
    return { before: target, user: this.publicUser(updated, roles, users) };
  }

  /** Set a new password. Signs the person out everywhere — except the session making the change. */
  async setPassword(actor, id, password) {
    const { users, roles } = await this.directory();
    const target = users.find((u) => u.id === id);
    this._requireManageable(target, actor);
    const problem = passwordProblem(password);
    if (problem) throw new AdminError(400, problem);

    const updated = {
      ...target,
      passwordHash: await hashPassword(password),
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date().toISOString(),
    };
    await dbService.saveAdminUser(updated);
    await this._revokeSessions(target.id, target.id === actor.user.id ? actor.sessionId : null);
    this.invalidate();
    return { user: this.publicUser(updated, roles, users), role: roles.find((r) => r.id === target.roleId) };
  }

  async deleteUser(actor, id) {
    const { users } = await this.directory();
    const target = users.find((u) => u.id === id);
    this._requireManageable(target, actor);
    if (target.id === actor.user.id) throw new AdminError(403, 'You can\'t delete your own account.');
    this._assertOwnerRemains(users, target, null, 'deleted');

    await dbService.deleteAdminSessions({ userId: target.id });
    await dbService.deleteAdminUser(target.id);
    this.invalidate();
    return target;
  }

  async _revokeSessions(userId, keepSessionId) {
    if (!keepSessionId) return dbService.deleteAdminSessions({ userId });
    // Keep the caller signed in when they change their own password.
    const kept = await dbService.getAdminSession(keepSessionId);
    await dbService.deleteAdminSessions({ userId });
    if (kept) await dbService.saveAdminSession(kept);
  }

  // ── Roles ──

  async saveRole(actor, body) {
    const { users, roles } = await this.directory();
    if (body.id === OWNER_ROLE_ID) throw new AdminError(403, 'The Owner role always has full access and can\'t be changed.');
    const existing = body.id ? roles.find((r) => r.id === body.id) : null;
    if (body.id && !existing) throw new AdminError(404, 'That role no longer exists.');

    const name = String(body.name || '').trim();
    if (!name) throw new AdminError(400, 'Give the role a name.');
    if (name.length > 40) throw new AdminError(400, 'Role name must be 40 characters or fewer.');
    if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== body.id)) {
      throw new AdminError(409, 'A role with that name already exists.');
    }
    const description = String(body.description || '').trim().slice(0, 200);
    const permissions = normalizePermissions(body.permissions);
    if (permissions.length === 0) throw new AdminError(400, 'Tick at least one permission, or the role can\'t open any page.');

    // Without this, anyone who can manage roles could hand themselves more access than they have.
    if (!actor.isOwner) {
      const beyond = permissions.filter((p) => !actor.can(p));
      if (beyond.length) throw new AdminError(403, 'You can\'t grant permissions your own role doesn\'t have.');
      if (existing && existing.id === actor.user.roleId) throw new AdminError(403, 'You can\'t change your own role.');
    }

    const now = new Date().toISOString();
    const role = {
      id: existing ? existing.id : newId('role'),
      name,
      description,
      permissions,
      system: false,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await dbService.saveAdminRole(role);
    this.invalidate();
    return { before: existing, role: { ...role, userCount: users.filter((u) => u.roleId === role.id).length } };
  }

  async deleteRole(actor, id) {
    const { users, roles } = await this.directory();
    const role = roles.find((r) => r.id === id);
    if (!role) throw new AdminError(404, 'That role no longer exists.');
    if (role.id === OWNER_ROLE_ID || role.system) throw new AdminError(403, 'The Owner role can\'t be deleted.');
    if (!actor.isOwner && role.permissions.some((p) => !actor.can(p))) {
      throw new AdminError(403, 'You can\'t delete a role with more access than your own.');
    }
    const holders = users.filter((u) => u.roleId === id).length;
    if (holders) {
      throw new AdminError(409, `${holders} user${holders === 1 ? ' still has' : 's still have'} this role. Move them to another role first.`);
    }
    await dbService.deleteAdminRole(id);
    this.invalidate();
    return role;
  }

  // ── Activity log ──

  /**
   * Record something a person did in the console. Never throws: a logging failure must not
   * turn a successful change into an error the person then retries.
   */
  async record(req, action, summary, who = null) {
    const actor = who || req.admin?.user || null;
    try {
      await dbService.appendAdminActivity({
        id: newId('act'),
        at: new Date().toISOString(),
        userId: actor?.id || null,
        userName: actor?.name || null,
        userEmail: actor?.email || null,
        roleName: req.admin?.role?.name || null,
        action,
        summary: String(summary).slice(0, 300),
        ip: clientIp(req),
      });
    } catch (err) {
      console.error('[Admin Auth] Could not write the activity log:', err.message);
    }
  }
}

const adminAuth = new AdminAuthService();
export default adminAuth;

function bearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

/**
 * Route guard. `requirePermission()` = any signed-in account; `requirePermission('tickets.manage')`
 * = signed in AND the role grants it. Sets `req.admin` for the handler.
 */
export function requirePermission(permission = null) {
  return async (req, res, next) => {
    try {
      const ctx = await adminAuth.authenticate(bearer(req));
      if (!ctx) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
      req.admin = ctx;
      if (permission && !ctx.can(permission)) {
        return res.status(403).json({ error: 'Your role doesn\'t allow this. Ask the store owner if you need access.' });
      }
      return next();
    } catch (err) {
      console.error('[Admin Auth] Session check failed:', err.message);
      return res.status(500).json({ error: 'Could not verify your session. Try again.' });
    }
  };
}

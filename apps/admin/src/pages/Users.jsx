import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth, useToast } from '../contexts.jsx';
import { relTime } from '../api.js';
import Modal from '../components/Modal.jsx';

const OWNER_ROLE_ID = 'owner';
const MIN_PASSWORD = 8;

// Unambiguous characters only (no 0/O, 1/l/I) — people often read these off a screen.
function generatePassword(length = 14) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#%+=?!'];
  const all = sets.join('');
  const rand = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = sets.map((s) => s[rand(s.length)]);
  while (chars.length < length) chars.push(all[rand(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rand(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

const consoleUrl = () => window.location.origin + import.meta.env.BASE_URL;

async function copyText(text, toast, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what + '.'); }
  catch { toast('Couldn\'t copy — select the text and copy it manually.', true); }
}

function PasswordInput({ id, value, onChange }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  return (
    <>
      <div className="pw-field">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD} characters`}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
      </div>
      <div className="pw-tools">
        <button type="button" className="btn ghost sm" onClick={() => { onChange(generatePassword()); setShow(true); }}>🎲 Generate strong password</button>
        {value && <button type="button" className="btn ghost sm" onClick={() => copyText(value, toast, 'Password copied')}>Copy</button>}
      </div>
    </>
  );
}

function EmailToggle({ checked, onChange, mailConfigured }) {
  return (
    <>
      <label className="check-lbl">
        <input type="checkbox" checked={checked} disabled={!mailConfigured} onChange={(e) => onChange(e.target.checked)} />
        Email the login details to this person
      </label>
      {!mailConfigured && (
        <div className="field-hint">Email isn't set up on the server yet, so you'll need to share the details yourself.</div>
      )}
    </>
  );
}

function UserModal({ mode, target, roles, mailConfigured, me, onClose, onSaved }) {
  const { api } = useAuth();
  const toast = useToast();
  const creating = mode === 'create';
  const assignable = roles.filter((r) => r.id !== OWNER_ROLE_ID || me.isOwner);
  const defaultRole = (assignable.find((r) => r.name === 'Tester') || assignable.find((r) => r.id !== OWNER_ROLE_ID) || assignable[0])?.id || '';
  const [form, setForm] = useState({
    name: target?.name || '',
    email: target?.email || '',
    roleId: target?.roleId || defaultRole,
    password: '',
    sendEmail: mailConfigured,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const self = target && target.id === me.id;
  const role = roles.find((r) => r.id === form.roleId);

  const submit = async (e) => {
    e?.preventDefault();
    if (!form.name.trim()) return toast('Enter their name.', true);
    if (!form.email.trim()) return toast('Enter their email address.', true);
    if (creating && form.password.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters.`, true);
    setBusy(true);
    try {
      if (creating) {
        const res = await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({ name: form.name, email: form.email, roleId: form.roleId, password: form.password, sendEmail: form.sendEmail }),
        });
        onSaved({ kind: 'created', res, creds: { name: res.user.name, email: res.user.email, password: form.password } });
      } else {
        await api('/api/admin/users/' + target.id, {
          method: 'POST',
          body: JSON.stringify({ name: form.name, email: form.email, roleId: form.roleId }),
        });
        onSaved({ kind: 'updated' });
      }
    } catch (err) {
      toast(err.message, true);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={creating ? 'Add a user' : `Edit ${target.name}`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={submit} disabled={busy}>
            {busy ? <span className="spin-sm" /> : creating ? (form.sendEmail ? 'Create & email login' : 'Create account') : 'Save changes'}
          </button>
        </>
      )}
    >
      <form onSubmit={submit}>
        <label htmlFor="u-name">Full name</label>
        <input id="u-name" value={form.name} autoFocus placeholder="e.g. Priya Sharma" onChange={(e) => set('name', e.target.value)} />

        <label htmlFor="u-email">Email <span className="hint">— this is their username</span></label>
        <input id="u-email" type="email" value={form.email} placeholder="name@example.com" onChange={(e) => set('email', e.target.value)} />

        <label htmlFor="u-role">Role</label>
        <select id="u-role" value={form.roleId} disabled={self} onChange={(e) => set('roleId', e.target.value)}>
          {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div className="field-hint">
          {self ? 'You can\'t change your own role.' : role?.description || 'Set what this role can do on the Roles tab.'}
        </div>

        {creating && (
          <>
            <label htmlFor="u-password">Password <span className="hint">— they'll sign in with exactly this</span></label>
            <PasswordInput id="u-password" value={form.password} onChange={(v) => set('password', v)} />
            <EmailToggle checked={form.sendEmail} onChange={(v) => set('sendEmail', v)} mailConfigured={mailConfigured} />
          </>
        )}
        {/* Enter in any field submits; the visible button lives in the modal footer. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PasswordModal({ target, me, mailConfigured, onClose, onSaved }) {
  const { api } = useAuth();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [sendEmail, setSendEmail] = useState(mailConfigured);
  const [busy, setBusy] = useState(false);
  const self = target.id === me.id;

  const submit = async (e) => {
    e?.preventDefault();
    if (password.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters.`, true);
    setBusy(true);
    try {
      const res = await api(`/api/admin/users/${target.id}/password`, {
        method: 'POST',
        body: JSON.stringify({ password, sendEmail }),
      });
      onSaved({ kind: 'password', res, creds: { name: target.name, email: target.email, password } });
    } catch (err) {
      toast(err.message, true);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`New password for ${target.name}`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={submit} disabled={busy}>{busy ? <span className="spin-sm" /> : 'Set password'}</button>
        </>
      )}
    >
      <form onSubmit={submit}>
        <p className="field-hint" style={{ marginTop: 14 }}>
          {self
            ? 'Your other signed-in devices will be signed out. This one stays signed in.'
            : `${target.name} will be signed out everywhere and must use the new password from now on.`}
        </p>
        <label htmlFor="p-password">New password</label>
        <PasswordInput id="p-password" value={password} onChange={setPassword} />
        <EmailToggle checked={sendEmail} onChange={setSendEmail} mailConfigured={mailConfigured} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// Shown when login details were NOT emailed, so the owner can pass them on another way.
function CredentialsNotice({ notice, onDone }) {
  const toast = useToast();
  const text = `Aurax admin console\nSign in: ${consoleUrl()}\nEmail: ${notice.email}\nPassword: ${notice.password}`;
  return (
    <div className="card pad notice fade">
      <strong style={{ fontSize: 15 }}>Share these login details with {notice.name}</strong>
      <p className="field-hint">{notice.reason}</p>
      <div className="cred-box">
        <div className="cred-row"><span className="k">Sign-in page</span><span className="v">{consoleUrl()}</span></div>
        <div className="cred-row"><span className="k">Email</span><span className="v">{notice.email}</span></div>
        <div className="cred-row"><span className="k">Password</span><span className="v mono">{notice.password}</span></div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={() => copyText(text, toast, 'Login details copied')}>📋 Copy login details</button>
        <button className="btn ghost sm" onClick={onDone}>Done — hide this</button>
      </div>
    </div>
  );
}

function UsersTab() {
  const { api, user: me } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [modal, setModal] = useState(null); // { kind: 'create'|'edit'|'password', target }
  const [notice, setNotice] = useState(null);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api('/api/admin/users')); }
    catch (e) { toast(e.message, true); setData((d) => d || { users: [], roles: [], mail: { configured: false } }); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const saved = ({ kind, res, creds }) => {
    setModal(null);
    load();
    if (kind === 'updated') return toast('Saved.');
    const verb = kind === 'created' ? 'Account created' : 'Password changed';
    if (res.mail?.sent) {
      setNotice(null);
      toast(`${verb} — login details emailed to ${creds.email}.`);
    } else {
      toast(`${verb}.`);
      setNotice({
        ...creds,
        reason: res.mail?.skipped
          ? 'You chose not to email them. This is the only time the password is shown — copy it now.'
          : `The email didn't send (${res.mail?.error}). This is the only time the password is shown — copy it now.`,
      });
    }
  };

  const update = async (u, body, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyId(u.id);
    try {
      await api('/api/admin/users/' + u.id, { method: 'POST', body: JSON.stringify(body) });
      toast('Saved.');
      load();
    } catch (e) { toast(e.message, true); }
    finally { setBusyId(null); }
  };

  const remove = async (u) => {
    if (!window.confirm(`Delete ${u.name}'s account?\n\nThey will be signed out and can't sign in again. Their past actions stay in the activity log.`)) return;
    setBusyId(u.id);
    try {
      await api('/api/admin/users/' + u.id, { method: 'DELETE' });
      toast('Account deleted.');
      load();
    } catch (e) { toast(e.message, true); }
    finally { setBusyId(null); }
  };

  const users = data?.users || [];
  const counts = useMemo(() => ({
    total: users.length,
    active: users.filter((u) => u.status === 'active').length,
    disabled: users.filter((u) => u.status !== 'active').length,
  }), [users]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return users;
    return users.filter((u) => [u.name, u.email, u.roleName].some((v) => String(v || '').toLowerCase().includes(term)));
  }, [users, q]);

  return (
    <div>
      {data && !data.mail.configured && (
        <div className="view-only">
          ✉️ <strong>Email isn't set up yet.</strong> Accounts work, but login details won't be emailed. You'll
          see them on screen to share yourself. To turn email on, add <code>BREVO_API_KEY</code> and{' '}
          <code>MAIL_FROM_EMAIL</code> to the server's settings.
        </div>
      )}

      {notice && <CredentialsNotice notice={notice} onDone={() => setNotice(null)} />}

      <div className="metrics compact">
        <div className="metric">
          <div className="top"><span className="lbl">Users</span><span className="ic blue">👥</span></div>
          <div className="val">{data ? counts.total : '…'}</div>
          <div className="foot">Everyone with a login</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Active</span><span className="ic green">✅</span></div>
          <div className="val">{data ? counts.active : '…'}</div>
          <div className="foot">Can sign in</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Disabled</span><span className="ic gold">⏸</span></div>
          <div className="val">{data ? counts.disabled : '…'}</div>
          <div className="foot">Blocked from signing in</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Roles</span><span className="ic blue">🛡</span></div>
          <div className="val">{data ? data.roles.length : '…'}</div>
          <div className="foot">Access levels</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="ic">👥</span> Team members
          <div style={{ flex: 1 }} />
          <input className="search-input" placeholder="Search name, email, role…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} />
          <button className="btn sm" disabled={!data} onClick={() => setModal({ kind: 'create' })}>➕ Add user</button>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Person</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Added</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
            </thead>
            <tbody>
              {data === null
                ? <tr><td colSpan="6" className="empty">Loading users…</td></tr>
                : visible.length === 0
                ? <tr><td colSpan="6" className="empty">{q ? 'Nobody matches your search.' : 'No users yet.'}</td></tr>
                : visible.map((u) => {
                    const self = u.id === me.id;
                    // Only an Owner may change an Owner's account; the server enforces this too.
                    const manageable = u.roleId !== OWNER_ROLE_ID || me.isOwner;
                    const busy = busyId === u.id;
                    return (
                      <tr key={u.id} style={u.status !== 'active' ? { opacity: 0.65 } : undefined}>
                        <td>
                          <div className="u-name">{u.name} {self && <span className="chip you">You</span>}</div>
                          <div className="u-phone">{u.email}</div>
                        </td>
                        <td><span className={'tag ' + (u.roleId === OWNER_ROLE_ID ? 'order' : 'blue')}>{u.roleName}</span></td>
                        <td>
                          {u.status !== 'active'
                            ? <span className="tag idle">Disabled</span>
                            : u.locked
                            ? <span className="tag alert" title="Too many wrong passwords">Locked</span>
                            : <span className="tag order">Active</span>}
                        </td>
                        <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{u.lastLoginAt ? relTime(u.lastLoginAt) : 'Never'}</td>
                        <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                          {new Date(u.createdAt).toLocaleDateString()}
                          {u.createdBy && <div className="u-phone">by {u.createdBy}</div>}
                        </td>
                        <td>
                          {manageable && (
                            <div className="row-actions">
                              {u.locked && u.status === 'active' && (
                                <button className="btn gold sm" disabled={busy} onClick={() => update(u, { unlock: true })}>Unlock</button>
                              )}
                              <button className="btn ghost sm" disabled={busy} onClick={() => setModal({ kind: 'edit', target: u })}>Edit</button>
                              <button className="btn ghost sm" disabled={busy} onClick={() => setModal({ kind: 'password', target: u })}>Password</button>
                              {!self && (u.status === 'active'
                                ? <button className="btn ghost sm" disabled={busy} onClick={() => update(u, { status: 'disabled' }, `Disable ${u.name}?\n\nThey'll be signed out right away and can't sign in until you enable the account again.`)}>Disable</button>
                                : <button className="btn sm" disabled={busy} onClick={() => update(u, { status: 'active' })}>Enable</button>)}
                              {!self && <button className="btn danger sm" disabled={busy} onClick={() => remove(u)}>Delete</button>}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (modal.kind === 'password'
        ? <PasswordModal target={modal.target} me={me} mailConfigured={data.mail.configured} onClose={() => setModal(null)} onSaved={saved} />
        : <UserModal mode={modal.kind} target={modal.target} roles={data.roles} mailConfigured={data.mail.configured} me={me} onClose={() => setModal(null)} onSaved={saved} />)}
    </div>
  );
}

function RoleModal({ role, catalog, onClose, onSaved }) {
  const { api } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [selected, setSelected] = useState(() => new Set(role?.permissions || []));
  const [busy, setBusy] = useState(false);

  const toggle = (perm, page) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(perm.key)) {
        // Taking away page access takes away everything else on that page with it.
        if (perm.key === page.viewPermission) {
          catalog.permissions.filter((p) => p.page === page.id).forEach((p) => next.delete(p.key));
        } else {
          next.delete(perm.key);
        }
      } else {
        next.add(perm.key);
        next.add(page.viewPermission);
      }
      return next;
    });
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (!name.trim()) return toast('Give the role a name.', true);
    if (selected.size === 0) return toast('Tick at least one permission.', true);
    setBusy(true);
    try {
      await api('/api/admin/roles', {
        method: 'POST',
        body: JSON.stringify({ id: role?.id, name, description, permissions: [...selected] }),
      });
      onSaved();
    } catch (err) {
      toast(err.message, true);
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={role ? `Edit role: ${role.name}` : 'New role'}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={submit} disabled={busy}>{busy ? <span className="spin-sm" /> : 'Save role'}</button>
        </>
      )}
    >
      <form onSubmit={submit}>
        <div className="row2">
          <div>
            <label htmlFor="r-name">Role name</label>
            <input id="r-name" value={name} autoFocus placeholder="e.g. Support staff" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="r-desc">Description <span className="hint">— optional</span></label>
            <input id="r-desc" value={description} placeholder="What this role is for" onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <label style={{ marginBottom: 0 }}>What can this role do?</label>
        <div className="field-hint">Ticking anything on a page also gives access to that page. People with this role see the change right away.</div>
        {catalog.pages.map((page) => (
          <div className="perm-group" key={page.id}>
            <div className="perm-page">{page.label}</div>
            {catalog.permissions.filter((p) => p.page === page.id).map((p) => (
              <label className="perm-row" key={p.key}>
                <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p, page)} />
                <span>
                  <span className="perm-label">{p.label}{p.danger && <span className="chip off">sensitive</span>}</span>
                  <span className="perm-desc">{p.description}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function RolesTab() {
  const { api } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // null = closed, { role } = open (role undefined when new)

  const load = useCallback(async () => {
    try { setData(await api('/api/admin/roles')); }
    catch (e) { toast(e.message, true); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const remove = async (role) => {
    if (!window.confirm(`Delete the ${role.name} role?`)) return;
    try {
      await api('/api/admin/roles/' + role.id, { method: 'DELETE' });
      toast('Role deleted.');
      load();
    } catch (e) { toast(e.message, true); }
  };

  const labelOf = (key) => data.permissions.find((p) => p.key === key)?.label || key;

  return (
    <div>
      <div className="section-head">
        <p>A role decides which pages someone can open and what they can change there. Give each person the smallest role that lets them do their job.</p>
        <button className="btn sm" disabled={!data} onClick={() => setEditing({})}>➕ New role</button>
      </div>

      {data === null ? <div className="empty">Loading roles…</div>
        : data.roles.map((role) => {
            const owner = role.id === data.ownerRoleId;
            return (
              <div className="entry fade" key={role.id}>
                <h4>{role.name}</h4>
                {role.description && <div className="ans">{role.description}</div>}
                <div className="chips">
                  <span className="chip">{role.userCount} user{role.userCount === 1 ? '' : 's'}</span>
                  {owner && <span className="chip lang">full access · locked</span>}
                </div>
                {!owner && data.pages.map((page) => {
                  const granted = role.permissions.filter((k) => k.split('.')[0] === page.id);
                  if (!granted.length) return null;
                  return <div className="perm-summary" key={page.id}><b>{page.label}:</b> {granted.map(labelOf).join(' · ')}</div>;
                })}
                {!owner && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn ghost sm" onClick={() => setEditing({ role })}>Edit</button>
                    <button className="btn danger sm" onClick={() => remove(role)}>Delete</button>
                  </div>
                )}
              </div>
            );
          })}

      {editing && data && (
        <RoleModal
          role={editing.role}
          catalog={data}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); toast('Role saved.'); load(); }}
        />
      )}
    </div>
  );
}

export default function Users() {
  const [sub, setSub] = useState('users');
  return (
    <div className="fade">
      <div className="section-head">
        <p>Give each person their own login. Their role decides which pages they can open and what they can change.</p>
      </div>
      <div className="subtabs">
        <button className={'subtab' + (sub === 'users' ? ' active' : '')} onClick={() => setSub('users')}>👤 Users</button>
        <button className={'subtab' + (sub === 'roles' ? ' active' : '')} onClick={() => setSub('roles')}>🛡 Roles</button>
      </div>
      {sub === 'users' ? <UsersTab /> : <RolesTab />}
    </div>
  );
}

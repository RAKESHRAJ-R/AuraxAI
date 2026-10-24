import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth, useToast } from '../contexts.jsx';
import { relTime } from '../api.js';

const PAGE_SIZE = 100;

// Area label + a colour (reuses the shared .tag variants) per action prefix.
const AREAS = {
  auth: { label: 'Sign-in', cls: 'idle' },
  users: { label: 'Users', cls: 'blue' },
  roles: { label: 'Roles', cls: 'blue' },
  knowledge: { label: 'Knowledge', cls: 'order' },
  sources: { label: 'Sources', cls: 'order' },
  tickets: { label: 'Tickets', cls: 'mid' },
  whatsapp: { label: 'WhatsApp', cls: 'alert' },
  monitor: { label: 'Monitor', cls: 'mid' },
};
// Worth drawing the eye to even though they aren't changes.
const WARNING_ACTIONS = new Set(['auth.login_failed', 'auth.locked']);

const areaOf = (action) => AREAS[String(action).split('.')[0]] || { label: 'Other', cls: 'idle' };

function when(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function Activity() {
  const { api } = useAuth();
  const toast = useToast();
  const [entries, setEntries] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState('');
  const [person, setPerson] = useState('all');
  const [area, setArea] = useState('all');

  const loadFirst = useCallback(async () => {
    try {
      const r = await api(`/api/admin/activity?limit=${PAGE_SIZE}`);
      setEntries(r.entries);
      setHasMore(r.hasMore);
    } catch (e) {
      toast(e.message, true);
      setEntries((prev) => prev || []);
    }
  }, [api, toast]);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  // Keep the first page fresh, but never yank away older pages someone has loaded.
  const loadedCount = useRef(0);
  loadedCount.current = entries ? entries.length : 0;
  useEffect(() => {
    const id = setInterval(() => {
      if (loadedCount.current <= PAGE_SIZE) loadFirst();
    }, 30000);
    return () => clearInterval(id);
  }, [loadFirst]);

  const loadMore = async () => {
    if (!entries?.length) return;
    setLoadingMore(true);
    try {
      const before = encodeURIComponent(entries[entries.length - 1].at);
      const r = await api(`/api/admin/activity?limit=${PAGE_SIZE}&before=${before}`);
      setEntries((cur) => [...cur, ...r.entries]);
      setHasMore(r.hasMore);
    } catch (e) { toast(e.message, true); }
    finally { setLoadingMore(false); }
  };

  const people = useMemo(() => {
    const seen = new Map();
    (entries || []).forEach((e) => {
      const key = e.userEmail || e.userName;
      if (key && !seen.has(key)) seen.set(key, e.userName || e.userEmail);
    });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);

  const visible = useMemo(() => {
    let list = entries || [];
    if (person !== 'all') list = list.filter((e) => (e.userEmail || e.userName) === person);
    if (area !== 'all') list = list.filter((e) => String(e.action).split('.')[0] === area);
    const term = q.trim().toLowerCase();
    if (term) list = list.filter((e) => [e.summary, e.userName, e.userEmail].some((v) => String(v || '').toLowerCase().includes(term)));
    return list;
  }, [entries, person, area, q]);

  return (
    <div className="fade">
      <div className="section-head">
        <p>Every change made in the console: who did it and when. Sign-ins and failed attempts are included. Simply viewing a page isn't recorded.</p>
        <button className="btn ghost sm" onClick={loadFirst}>↻ Refresh</button>
      </div>

      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="ic">📜</span> Activity
          <div style={{ flex: 1 }} />
          <select className="search-input" value={person} onChange={(e) => setPerson(e.target.value)} style={{ maxWidth: 190 }} aria-label="Filter by person">
            <option value="all">Everyone</option>
            {people.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <select className="search-input" value={area} onChange={(e) => setArea(e.target.value)} style={{ maxWidth: 160 }} aria-label="Filter by area">
            <option value="all">All areas</option>
            {Object.entries(AREAS).map(([key, a]) => <option key={key} value={key}>{a.label}</option>)}
          </select>
          <input className="search-input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 180 }} />
        </div>

        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Area</th><th>What happened</th></tr></thead>
            <tbody>
              {entries === null
                ? <tr><td colSpan="4" className="empty">Loading activity…</td></tr>
                : visible.length === 0
                ? <tr><td colSpan="4" className="empty">{entries.length ? 'Nothing matches these filters.' : 'No activity recorded yet.'}</td></tr>
                : visible.map((e) => {
                    const a = areaOf(e.action);
                    const warn = WARNING_ACTIONS.has(e.action);
                    return (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: 'nowrap' }} title={new Date(e.at).toLocaleString()}>
                          <div>{when(e.at)}</div>
                          <div className="u-phone">{relTime(e.at)}</div>
                        </td>
                        <td>
                          <div className="u-name">{e.userName || (e.userEmail ? 'Unknown account' : '—')}</div>
                          <div className="u-phone">{e.userEmail || ''}{e.roleName ? ` · ${e.roleName}` : ''}</div>
                        </td>
                        <td><span className={'tag ' + (warn ? 'alert' : a.cls)}>{a.label}</span></td>
                        <td style={{ minWidth: 260, whiteSpace: 'normal', color: warn ? 'var(--danger)' : undefined }} title={e.ip ? `IP ${e.ip}` : undefined}>
                          {e.summary}
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <div style={{ padding: 14, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button className="btn ghost sm" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : 'Load older activity'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

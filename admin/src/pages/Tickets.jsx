import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts.jsx';
import { relTime } from '../api.js';

// Friendly labels + a colour class (reuses the shared .tag variants) per issue type.
const ISSUE = {
  wrong_item:         { label: 'Wrong item',         cls: 'alert' },
  damaged:            { label: 'Damaged',            cls: 'alert' },
  missing_package:    { label: 'Missing package',    cls: 'alert' },
  delayed:            { label: 'Delayed delivery',   cls: 'mid' },
  wrong_customization:{ label: 'Wrong customization',cls: 'mid' },
  exchange:           { label: 'Exchange',           cls: 'mid' },
  talk_to_human:      { label: 'Talk to human',      cls: 'order' },
  other:              { label: 'Other',              cls: 'idle' },
};
const issueMeta = (t) => ISSUE[t] || { label: t || 'Other', cls: 'idle' };

export default function Tickets() {
  const { api } = useAuth();
  const [tickets, setTickets] = useState(null);
  const [filter, setFilter] = useState('open'); // open | resolved | all
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    try { const t = await api('/api/tickets'); setTickets(t); } catch { /* silent */ }
  };

  useEffect(() => {
    let alive = true;
    const run = async () => { const t = await api('/api/tickets').catch(() => null); if (alive && t) setTickets(t); };
    run();
    const id = setInterval(run, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [api]);

  const setStatus = async (id, status) => {
    setBusyId(id);
    try {
      await api(`/api/tickets/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await load();
    } catch { /* silent */ } finally { setBusyId(null); }
  };

  const counts = useMemo(() => {
    const list = tickets || [];
    return {
      total: list.length,
      open: list.filter((t) => (t.status || 'open') === 'open').length,
      resolved: list.filter((t) => t.status === 'resolved').length,
      photos: list.filter((t) => t.hasPhoto).length,
    };
  }, [tickets]);

  const visible = useMemo(() => {
    let list = tickets || [];
    if (filter !== 'all') list = list.filter((t) => (t.status || 'open') === filter);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter((t) =>
        [t.id, t.name, t.phone, t.orderId, t.description, issueMeta(t.issueType).label]
          .some((v) => String(v || '').toLowerCase().includes(term)));
    }
    return list;
  }, [tickets, filter, q]);

  return (
    <div className="fade">
      <div className="section-head">
        <p>After-sales support tickets raised by Aura (complaints, returns, tracking, escalations). Owner is also alerted live on WhatsApp &amp; Telegram. Auto-refreshes.</p>
        <span className="wa-status on" style={{ margin: 0 }}><span className="dot" /> Live</span>
      </div>

      <div className="metrics">
        <div className="metric">
          <div className="top"><span className="lbl">Total Tickets</span><span className="ic blue">🎫</span></div>
          <div className="val">{counts.total}</div>
          <div className="foot">All time</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Open</span><span className="ic gold">📬</span></div>
          <div className="val">{counts.open}</div>
          <div className="foot">Awaiting the team</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Resolved</span><span className="ic green">✅</span></div>
          <div className="val">{counts.resolved}</div>
          <div className="foot">Closed out</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">With Photos</span><span className="ic blue">📷</span></div>
          <div className="val">{counts.photos}</div>
          <div className="foot">Image forwarded to owner</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="ic">🎫</span> Support Tickets
          <div style={{ flex: 1 }} />
          <div className="seg">
            {['open', 'resolved', 'all'].map((f) => (
              <button key={f} className={'seg-btn' + (filter === f ? ' on' : '')} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <input
            className="search-input"
            placeholder="Search name, phone, order, issue…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 240 }}
          />
        </div>

        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticket</th><th>Customer</th><th>Issue</th><th>Order</th>
                <th>Photo</th><th>Details</th><th>Created</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {tickets === null
                ? <tr><td colSpan="8" className="empty">Loading tickets…</td></tr>
                : visible.length === 0
                ? <tr><td colSpan="8" className="empty">No {filter === 'all' ? '' : filter} tickets{q ? ' match your search' : ''}.</td></tr>
                : visible.map((t) => {
                    const im = issueMeta(t.issueType);
                    const resolved = t.status === 'resolved';
                    return (
                      <tr key={t.id} style={resolved ? { opacity: 0.6 } : undefined}>
                        <td><div className="u-name" style={{ fontFamily: 'monospace' }}>{t.id}</div></td>
                        <td>
                          <div className="u-name">{t.name || 'Customer'}</div>
                          <div className="u-phone">+{String(t.phone || '').replace(/[^0-9]/g, '')}</div>
                          {t.email && <div className="u-phone">{t.email}</div>}
                        </td>
                        <td><span className={'tag ' + im.cls}>{im.label}</span></td>
                        <td>{t.orderId ? <span style={{ fontFamily: 'monospace' }}>#{t.orderId}</span> : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                        <td>{t.hasPhoto ? '📷' : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                        <td style={{ maxWidth: 280, whiteSpace: 'normal', color: 'var(--muted)' }}>{t.description || '—'}</td>
                        <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{relTime(t.createdAt)}</td>
                        <td>
                          {resolved
                            ? <button className="btn ghost sm" disabled={busyId === t.id} onClick={() => setStatus(t.id, 'open')}>Reopen</button>
                            : <button className="btn sm" disabled={busyId === t.id} onClick={() => setStatus(t.id, 'resolved')}>Resolve</button>}
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend,
} from 'chart.js';
import { useAuth } from '../contexts.jsx';
import { relTime } from '../api.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

const TOKEN_LIMITS = { groq: 200000, openai: 1000000, gemini: 500000, openrouter: 300000, fireworks: 500000, sarvam: 500000 };

function TrafficChart({ recentCalls }) {
  const { labels, success, errors } = useMemo(() => {
    const now = Date.now();
    const bins = [];
    for (let i = 7; i >= 0; i--) {
      const t = new Date(now - i * 3 * 3600 * 1000);
      bins.push({
        label: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        startMs: now - (i + 1) * 3 * 3600 * 1000,
        endMs: now - i * 3 * 3600 * 1000,
        success: 0, errors: 0,
      });
    }
    (recentCalls || []).forEach((c) => {
      for (const b of bins) {
        if (c.timestamp >= b.startMs && c.timestamp < b.endMs) { c.success ? b.success++ : b.errors++; break; }
      }
    });
    return { labels: bins.map((b) => b.label), success: bins.map((b) => b.success), errors: bins.map((b) => b.errors) };
  }, [recentCalls]);

  const data = {
    labels,
    datasets: [
      { label: 'Successful', data: success, borderColor: '#0e7a4b', backgroundColor: 'rgba(14,122,75,.08)', borderWidth: 2, fill: true, tension: 0.35, pointRadius: 2 },
      { label: 'Errors', data: errors, borderColor: '#d24545', backgroundColor: 'rgba(210,69,69,.06)', borderWidth: 2, fill: true, tension: 0.35, pointRadius: 2 },
    ],
  };
  const options = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#6c7280', font: { family: 'Inter', size: 12, weight: '600' }, usePointStyle: true, boxWidth: 7 } } },
    scales: {
      x: { grid: { color: 'rgba(0,0,0,.05)' }, ticks: { color: '#9aa0ac', font: { family: 'Inter', size: 11 } } },
      y: { grid: { color: 'rgba(0,0,0,.05)' }, ticks: { color: '#9aa0ac', font: { family: 'Inter', size: 11 }, precision: 0 } },
    },
  };
  return <div style={{ position: 'relative', height: 260, width: '100%' }}><Line data={data} options={options} /></div>;
}

export default function Monitor() {
  const { api } = useAuth();
  const [prov, setProv] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [logs, setLogs] = useState(null);
  const termRef = useRef(null);
  const atBottom = useRef(true);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const p = await api('/api/provider-stats'); if (alive) setProv(p); } catch { /* silent */ }
      try { const s = await api('/api/sessions'); if (alive) setSessions(s); } catch { /* silent */ }
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [api]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const l = await api('/api/logs');
        if (!alive) return;
        const el = termRef.current;
        if (el) atBottom.current = el.scrollHeight - el.clientHeight <= el.scrollTop + 20;
        setLogs(l);
      } catch { /* silent */ }
    };
    refresh();
    const id = setInterval(refresh, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [api]);

  useEffect(() => {
    if (termRef.current && atBottom.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [logs]);

  const providers = prov?.providers || {};
  const activeProv = prov?.active?.provider;
  let ok = 0, errs = 0;
  Object.values(providers).forEach((p) => { ok += p.success || 0; errs += p.errors || 0; });

  const keyRows = [];
  const now = Date.now();
  Object.entries(prov?.apiKeys || {}).forEach(([p, count]) => {
    if (p === 'total' || !count) return;
    for (let i = 0; i < count; i++) {
      const ek = `${p}#${i}`;
      const until = prov?.keyExhaustedUntil?.[ek];
      const ex = until && now < until;
      keyRows.push({ p, i, ex, coolMs: ex ? until - now : 0, active: p === activeProv && i === prov?.active?.keyIndex });
    }
  });

  return (
    <div className="fade">
      <div className="section-head">
        <p>Live view of API usage, provider health, active customer chats, and server logs. Refreshes automatically.</p>
        <span className="wa-status on" style={{ margin: 0 }}><span className="dot" /> Live</span>
      </div>

      <div className="metrics">
        <div className="metric">
          <div className="top"><span className="lbl">API Requests</span><span className="ic green">🖧</span></div>
          <div className="val">{prov?.totals?.calls || 0}</div>
          <div className="foot"><span style={{ color: 'var(--accent)' }}>{ok} success</span> · <span style={{ color: 'var(--danger)' }}>{errs} errors</span></div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Tokens Used</span><span className="ic blue">🧮</span></div>
          <div className="val">{(prov?.totals?.tokens || 0).toLocaleString()}</div>
          <div className="foot">Across all providers</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Active Chats</span><span className="ic green">💬</span></div>
          <div className="val">{sessions ? sessions.length : 0}</div>
          <div className="foot">Live customer sessions</div>
        </div>
        <div className="metric">
          <div className="top"><span className="lbl">Active Provider</span><span className="ic gold">🧠</span></div>
          <div className="val" style={{ fontSize: 20, marginTop: 14, textTransform: 'capitalize' }}>{activeProv || 'None'}</div>
          <div className="foot">Key #{prov?.active?.keyIndex ?? 0}</div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-title"><span className="ic">📈</span> Call Traffic & Token Usage</div>
          <div style={{ padding: 18 }}>
            <TrafficChart recentCalls={prov?.recentCalls || []} />
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 14 }}>Token usage by provider</div>
              {Object.keys(providers).length === 0
                ? <div className="empty" style={{ padding: 20 }}>No calls yet.</div>
                : Object.entries(providers).map(([name, d]) => {
                    const used = d.tokensUsed || 0;
                    const pct = Math.min(100, Math.round((used / (TOKEN_LIMITS[name] || 500000)) * 100));
                    return (
                      <div className="tok" key={name}>
                        <div className="tok-meta"><span style={{ textTransform: 'capitalize' }}>{name}</span><span className="g">{used.toLocaleString()} tokens ({pct}%)</span></div>
                        <div className="tok-bar"><span style={{ width: pct + '%' }} /></div>
                      </div>
                    );
                  })}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><span className="ic">🔑</span> API Keys & Cooldowns</div>
          <div style={{ padding: 18 }}>
            <div className="keys">
              {keyRows.length === 0
                ? <div className="empty" style={{ padding: 20 }}>No keys loaded.</div>
                : keyRows.map(({ p, i, ex, coolMs, active }) => (
                    <div className="key-row" key={p + i}>
                      <div className="nm"><span className="dot" style={{ background: active ? 'var(--accent)' : 'var(--faint)' }} />{p} · Key #{i}</div>
                      {ex
                        ? <span className="pill cool">Cooldown {Math.floor(coolMs / 60000)}m {Math.floor((coolMs % 60000) / 1000)}s</span>
                        : <span className="pill ok">Active</span>}
                    </div>
                  ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title"><span className="ic">👥</span> Active Chat Sessions</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Customer</th><th>State</th><th>Language</th><th>Cart</th><th>Escalate</th><th>Last active</th></tr></thead>
            <tbody>
              {sessions === null
                ? <tr><td colSpan="6" className="empty">Loading sessions…</td></tr>
                : sessions.length === 0
                ? <tr><td colSpan="6" className="empty">No active customer sessions.</td></tr>
                : sessions.map((s, idx) => {
                    const phone = String(s.userId).replace(/[^0-9]/g, '');
                    const cls = s.state === 'IDLE' ? 'idle' : (s.state.includes('CONFIRMING') || s.state.includes('ORDER')) ? 'order' : 'mid';
                    return (
                      <tr key={idx}>
                        <td><div className="u-name">Customer</div><div className="u-phone">+{phone}</div></td>
                        <td><span className={'tag ' + cls}>{s.state}</span></td>
                        <td style={{ textTransform: 'capitalize' }}>{s.language}</td>
                        <td>{s.cart && s.cart.length ? `${s.cart[0].qty}× ${s.cart[0].name} (${s.cart[0].size})` : <span style={{ color: 'var(--faint)', fontStyle: 'italic' }}>Empty</span>}</td>
                        <td>{s.requiresEscalation ? <span className="tag alert">Alert</span> : <span style={{ color: 'var(--faint)' }}>No</span>}</td>
                        <td style={{ color: 'var(--muted)' }}>{relTime(s.lastActive)}</td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="terminal">
        <div className="bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span className="lights"><i style={{ background: '#f0736f' }} /><i style={{ background: '#e8b654' }} /><i style={{ background: '#0e7a4b' }} /></span>
            <span>Server console</span>
          </div>
          <span>Rolling buffer (250 lines)</span>
        </div>
        <div className="body" ref={termRef}>
          {logs === null || logs.length === 0
            ? <div className="log info"><span className="ts">[system]</span> {logs === null ? 'Connecting to server console…' : 'No logs captured yet.'}</div>
            : logs.map((l, i) => {
                const ts = new Date(l.timestamp).toLocaleTimeString([], { hour12: false });
                const c = l.type === 'error' ? 'error' : l.type === 'warn' ? 'warn' : 'info';
                return <div className={'log ' + c} key={i}><span className="ts">[{ts}]</span> {l.message}</div>;
              })}
        </div>
      </div>
    </div>
  );
}

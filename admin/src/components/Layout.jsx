import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts.jsx';

const SECTIONS = [
  { id: 'monitor', label: 'Monitor', icon: '📊', title: 'Monitoring Dashboard', live: true },
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬', title: 'WhatsApp Connection' },
  { id: 'knowledge', label: 'Knowledge Hub', icon: '🧠', title: 'Knowledge Hub' },
];

export default function Layout({ children }) {
  const { logout, api } = useAuth();
  const [drawer, setDrawer] = useState(false);
  const [pending, setPending] = useState(0);
  const { pathname } = useLocation();
  const active = SECTIONS.find((s) => pathname.startsWith('/' + s.id)) || SECTIONS[0];

  // Poll how many auto-diagnosed questions are waiting for an answer (nav badge).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await api('/api/knowledge/pending-count'); if (alive) setPending(r.count || 0); }
      catch { /* silent */ }
    };
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [api, pathname]);

  return (
    <div className="app">
      <div className={'overlay' + (drawer ? ' show' : '')} onClick={() => setDrawer(false)} />

      <aside className={'sidebar' + (drawer ? ' open' : '')}>
        <div className="brand">
          <span className="mark">⚽</span>
          <div>
            <div className="name">Theaurax</div>
            <div className="sub">Admin console</div>
          </div>
        </div>
        <nav className="nav">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.id}
              to={'/' + s.id}
              className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
              onClick={() => setDrawer(false)}
            >
              <span className="ic">{s.icon}</span>
              {s.label}
              {s.live && <span className="nav-badge">live</span>}
              {s.id === 'knowledge' && pending > 0 && (
                <span className="nav-badge alert" title={`${pending} question(s) need an answer`}>{pending}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="btn ghost sm" style={{ width: '100%' }} onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setDrawer((d) => !d)}>
            ☰
          </button>
          <h1>{active.title}</h1>
          <div className="spacer" />
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

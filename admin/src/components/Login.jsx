import { useState } from 'react';
import { useAuth } from '../contexts.jsx';

export default function Login() {
  const { login } = useAuth();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const res = await fetch('/api/knowledge-hub/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || 'Login failed');
        return;
      }
      login(data.token);
    } catch {
      setErr('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="card login-card fade">
        <div className="brand" style={{ justifyContent: 'center', padding: '0 0 8px' }}>
          <span className="mark">⚽</span>
          <div style={{ textAlign: 'left' }}>
            <div className="name">Theaurax Admin</div>
            <div className="sub">Store control console</div>
          </div>
        </div>
        <p className="desc">Sign in to manage the bot, WhatsApp link, and monitoring.</p>
        <label style={{ textAlign: 'left' }}>Password</label>
        <input
          type="password"
          value={pw}
          autoFocus
          placeholder="Enter admin password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={busy} onClick={submit}>
          {busy ? <span className="spin-sm" /> : 'Sign in'}
        </button>
        <p style={{ color: 'var(--danger)', minHeight: 18, marginTop: 10, fontSize: 13.5 }}>{err}</p>
      </div>
    </div>
  );
}

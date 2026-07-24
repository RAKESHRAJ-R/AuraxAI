import { useState } from 'react';
import { useAuth } from '../contexts.jsx';
import logo from '../assets/aurax-logo.png';

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
      login(data.token, data.team, data.label);
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
          <span className="mark logo"><img src={logo} alt="Aurax" /></span>
          <div style={{ textAlign: 'left' }}>
            <div className="name">AURAX Admin</div>
            <div className="sub">Store control console</div>
          </div>
        </div>
        <p className="desc">Restricted to the Aurax team and testing team. Enter your team password to continue.</p>
        <label style={{ textAlign: 'left' }}>Team password</label>
        <input
          type="password"
          value={pw}
          autoFocus
          placeholder="Enter your team password"
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

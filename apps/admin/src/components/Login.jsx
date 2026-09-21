import { useState } from 'react';
import { useAuth } from '../contexts.jsx';
import { apiUrl } from '../api.js';
import logo from '../assets/aurax-logo.png';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!email.trim() || !pw) {
      setErr('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || 'Sign-in failed.');
        return;
      }
      login(data.token, data.user);
    } catch {
      setErr('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card fade" onSubmit={submit} noValidate>
        <div className="brand" style={{ justifyContent: 'center', padding: '0 0 8px' }}>
          <span className="mark logo"><img src={logo} alt="Aurax" /></span>
          <div style={{ textAlign: 'left' }}>
            <div className="name">AURAX Admin</div>
            <div className="sub">Store control console</div>
          </div>
        </div>
        <p className="desc">Sign in with the email and password the Aurax team sent you.</p>
        <label htmlFor="login-email" style={{ textAlign: 'left' }}>Email</label>
        <input
          id="login-email"
          type="email"
          value={email}
          autoFocus
          autoComplete="username"
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="login-password" style={{ textAlign: 'left' }}>Password</label>
        <div className="pw-field">
          <input
            id="login-password"
            type={showPw ? 'text' : 'password'}
            value={pw}
            autoComplete="current-password"
            placeholder="Enter your password"
            onChange={(e) => setPw(e.target.value)}
          />
          <button type="button" className="pw-toggle" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}>
            {showPw ? 'Hide' : 'Show'}
          </button>
        </div>
        <button type="submit" className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
          {busy ? <span className="spin-sm" /> : 'Sign in'}
        </button>
        <p style={{ color: 'var(--danger)', minHeight: 18, marginTop: 10, fontSize: 13.5 }} role="alert">{err}</p>
        <p className="login-foot">Forgot your password? Ask the store owner to set a new one.</p>
      </form>
    </div>
  );
}

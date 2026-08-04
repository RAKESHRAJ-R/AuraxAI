import { useEffect, useState } from 'react';
import { useAuth } from '../contexts.jsx';
import { relTime } from '../api.js';

const BADGE = {
  DISCONNECTED: { cls: 'off', text: 'Disconnected' },
  CONNECTING: { cls: 'connecting', text: 'Connecting…' },
  QR_READY: { cls: 'qr', text: 'Scan QR code' },
  CONNECTED: { cls: 'on', text: 'Connected & active' },
};

// "919876543210" → "+91 98765 43210". Falls back to a plain +number for anything that
// isn't a 12-digit Indian MSISDN, since the bot can be paired to any country's number.
function formatNumber(raw) {
  if (!raw) return 'Unknown number';
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return '+' + d;
}

export default function WhatsApp() {
  const { api } = useAuth();
  const [status, setStatus] = useState('DISCONNECTED');
  const [qr, setQr] = useState(null);
  const [err, setErr] = useState(false);
  const [device, setDevice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const d = await api('/api/whatsapp/status');
        if (!alive) return;
        setErr(false);
        setStatus(d.status || 'DISCONNECTED');
        setQr(d.qrDataUrl || null);
        setDevice(d.device || null);
      } catch {
        if (alive) { setErr(true); setStatus('DISCONNECTED'); setQr(null); setDevice(null); }
      }
    };
    poll();
    const id = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [api]);

  const doLogout = async () => {
    const who = device?.number ? formatNumber(device.number) : 'this number';
    // Unlinking stops the bot answering customers until someone re-scans, so make the
    // admin confirm against the actual number rather than a generic "are you sure".
    if (!window.confirm(
      `Log out ${who}?\n\nThe bot will STOP replying to customers on this number until a new QR code is scanned.`
    )) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await api('/api/whatsapp/logout', { method: 'POST' });
      setStatus('DISCONNECTED');
      setDevice(null);
      setQr(null);
      setNotice({ ok: true, text: r.message || 'Logged out.' });
    } catch (e) {
      setNotice({ ok: false, text: e.message || 'Logout failed.' });
    } finally {
      setBusy(false);
    }
  };

  const b = BADGE[status] || BADGE.DISCONNECTED;
  const showQr = status === 'QR_READY' && qr;
  const showLoader = !err && (status === 'DISCONNECTED' || status === 'CONNECTING' || (status === 'QR_READY' && !qr));

  return (
    <div className="wa-wrap fade">
      <div className="card wa-card">
        <div className="wa-logo">⚽</div>
        <h2>WhatsApp Web Link</h2>
        <p className="desc">Connect your WhatsApp number directly to the AI assistant.</p>
        <div>
          <span className={'wa-status ' + b.cls}><span className="dot" /> {b.text}</span>
        </div>
        <div className="qr-box">
          {err ? <div style={{ color: 'var(--danger)', fontSize: 13, padding: 20 }}>Can't reach the server. Retrying…</div>
            : showLoader ? <div className="spinner" />
            : showQr ? <img src={qr} alt="WhatsApp QR" />
            : status === 'CONNECTED' ? <div className="check">✓</div>
            : <div className="spinner" />}
        </div>
        {status === 'CONNECTED' && (
          <>
            <div className="wa-device">
              <div className="wa-device-row">
                <span className="k">Linked number</span>
                <span className="v num">{formatNumber(device?.number)}</span>
              </div>
              {device?.name && (
                <div className="wa-device-row">
                  <span className="k">Account name</span>
                  <span className="v">{device.name}</span>
                </div>
              )}
              {device?.platform && (
                <div className="wa-device-row">
                  <span className="k">Device</span>
                  <span className="v">{device.platform}</span>
                </div>
              )}
              <div className="wa-device-row">
                <span className="k">Linked since</span>
                <span className="v">{relTime(device?.connectedAt)}</span>
              </div>
            </div>
            <p className="desc" style={{ marginTop: 14 }}>
              <strong style={{ color: 'var(--accent)' }}>Connected!</strong> The bot answers every message sent to this number.
            </p>
            <button className="btn danger" style={{ marginTop: 14 }} disabled={busy} onClick={doLogout}>
              {busy ? 'Logging out…' : '🔌 Log out this number'}
            </button>
          </>
        )}
        {notice && (
          <p className="desc" style={{ marginTop: 14, color: notice.ok ? 'var(--accent)' : 'var(--danger)' }}>
            {notice.text}
          </p>
        )}
        {status === 'QR_READY' && (
          <div className="steps">
            <div className="t">🤳 How to pair</div>
            <ol>
              <li>Open <strong>WhatsApp</strong> on your phone</li>
              <li>Tap <strong>Menu</strong> (Android) or <strong>Settings</strong> (iOS)</li>
              <li>Tap <strong>Linked devices → Link a device</strong></li>
              <li>Scan the QR code above</li>
            </ol>
          </div>
        )}
        <div className="banner">🔒 <strong>Safe mode</strong>: if tester numbers are configured, the bot only replies to those.</div>
      </div>
    </div>
  );
}

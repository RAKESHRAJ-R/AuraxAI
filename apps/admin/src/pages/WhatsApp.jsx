import { useEffect, useState } from 'react';
import { useAuth } from '../contexts.jsx';

const BADGE = {
  DISCONNECTED: { cls: 'off', text: 'Disconnected' },
  CONNECTING: { cls: 'connecting', text: 'Connecting…' },
  QR_READY: { cls: 'qr', text: 'Scan QR code' },
  CONNECTED: { cls: 'on', text: 'Connected & active' },
};

export default function WhatsApp() {
  const { api } = useAuth();
  const [status, setStatus] = useState('DISCONNECTED');
  const [qr, setQr] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const d = await api('/api/whatsapp/status');
        if (!alive) return;
        setErr(false);
        setStatus(d.status || 'DISCONNECTED');
        setQr(d.qrDataUrl || null);
      } catch {
        if (alive) { setErr(true); setStatus('DISCONNECTED'); setQr(null); }
      }
    };
    poll();
    const id = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [api]);

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
          <p className="desc" style={{ marginTop: 18 }}>
            <strong style={{ color: 'var(--accent)' }}>Connected!</strong> The bot now answers messages sent to your number.
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

import { useEffect, useState } from 'react';
import { useAuth } from '../contexts.jsx';
import { relTime } from '../api.js';

const BADGE = {
  DISCONNECTED: { cls: 'off', text: 'Disconnected' },
  CONNECTING: { cls: 'connecting', text: 'Connecting…' },
  QR_READY: { cls: 'qr', text: 'Scan QR code' },
  CODE_READY: { cls: 'qr', text: 'Enter code on phone' },
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
  const { api, can } = useAuth();
  // Linking and unlinking the number. Without it the server withholds the QR and the
  // linking code too, since either one lets whoever sees it pair their own phone.
  const canManage = can('whatsapp.manage');
  const [status, setStatus] = useState('DISCONNECTED');
  const [qr, setQr] = useState(null);
  const [err, setErr] = useState(false);
  const [device, setDevice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  // Phone-number linking. pairingPhone/pairingCode come from the server; phoneForm/phoneInput
  // are just the local "type your number" form shown before a code has been requested.
  const [pairingPhone, setPairingPhone] = useState(null);
  const [pairingCode, setPairingCode] = useState(null);
  const [phoneForm, setPhoneForm] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');

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
        setPairingPhone(d.pairingPhone || null);
        setPairingCode(d.pairingCode || null);
      } catch {
        if (alive) { setErr(true); setStatus('DISCONNECTED'); setQr(null); setDevice(null); setPairingCode(null); }
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

  const startPairing = async (e) => {
    e.preventDefault();
    if (!phoneInput.trim()) {
      setNotice({ ok: false, text: 'Enter the WhatsApp number to link.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const r = await api('/api/whatsapp/pair', { method: 'POST', body: JSON.stringify({ phoneNumber: phoneInput }) });
      setPairingPhone(r.phoneNumber);
      setPairingCode(null);
      setQr(null);
      setStatus('CONNECTING');
      setPhoneForm(false);
      setNotice({ ok: true, text: r.message });
    } catch (e2) {
      setNotice({ ok: false, text: e2.message || 'Could not start phone-number linking.' });
    } finally {
      setBusy(false);
    }
  };

  const backToQr = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api('/api/whatsapp/pair/cancel', { method: 'POST' });
      setPairingPhone(null);
      setPairingCode(null);
      setStatus('CONNECTING');
      setNotice({ ok: true, text: r.message });
    } catch (e) {
      setNotice({ ok: false, text: e.message || 'Could not switch back to QR.' });
    } finally {
      setBusy(false);
    }
  };

  const b = BADGE[status] || BADGE.DISCONNECTED;
  const phoneMode = status !== 'CONNECTED' && !!pairingPhone;
  const showCode = phoneMode && status === 'CODE_READY' && pairingCode;
  const showQr = !phoneMode && status === 'QR_READY' && qr;
  // WhatsApp shows the code as "ABCD-EFGH" on the phone side, so match it.
  const prettyCode = pairingCode && pairingCode.length === 8 ? `${pairingCode.slice(0, 4)}-${pairingCode.slice(4)}` : pairingCode;

  return (
    <div className="wa-wrap fade">
      <div className="card wa-card">
        <div className="wa-logo">⚽</div>
        <h2>WhatsApp Web Link</h2>
        <p className="desc">Connect your WhatsApp number directly to the AI assistant.</p>
        <div>
          <span className={'wa-status ' + b.cls}><span className="dot" /> {b.text}</span>
        </div>
        <div className={'qr-box' + (phoneMode ? ' code' : '')}>
          {err ? <div style={{ color: 'var(--danger)', fontSize: 13, padding: 20 }}>Can't reach the server. Retrying…</div>
            : showCode ? (
              <div>
                <div className="pair-code">{prettyCode}</div>
                <div className="pair-for">for {formatNumber(pairingPhone)}</div>
              </div>
            )
            : showQr ? <img src={qr} alt="WhatsApp QR" />
            : status === 'CONNECTED' ? <div className="check">✓</div>
            : !canManage && (status === 'QR_READY' || status === 'CODE_READY')
              ? <div className="locked-msg">🔒 Waiting for someone who is allowed to link the number.</div>
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
            {canManage && (
              <button className="btn danger" style={{ marginTop: 14 }} disabled={busy} onClick={doLogout}>
                {busy ? 'Logging out…' : '🔌 Log out this number'}
              </button>
            )}
          </>
        )}
        {notice && (
          <p className="desc" style={{ marginTop: 14, color: notice.ok ? 'var(--accent)' : 'var(--danger)' }}>
            {notice.text}
          </p>
        )}
        {canManage && !phoneMode && status === 'QR_READY' && (
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
        {canManage && phoneMode && (
          <div className="steps">
            <div className="t">📱 Link with phone number</div>
            <ol>
              <li>Open <strong>WhatsApp</strong> on the phone for {formatNumber(pairingPhone)}</li>
              <li>Tap <strong>Menu</strong> (Android) or <strong>Settings</strong> (iOS) → <strong>Linked devices → Link a device</strong></li>
              <li>Tap <strong>Link with phone number instead</strong> at the bottom of the scanner</li>
              <li>Enter the 8-character code above. WhatsApp may also send a notification you can tap.</li>
            </ol>
            <p className="pair-note">The code refreshes every 3 minutes. Enter the one shown here now.</p>
          </div>
        )}
        {canManage && status !== 'CONNECTED' && !phoneMode && !phoneForm && (
          <button className="btn ghost" style={{ marginTop: 14 }} disabled={busy} onClick={() => { setPhoneForm(true); setNotice(null); }}>
            📱 Link with phone number instead
          </button>
        )}
        {canManage && status !== 'CONNECTED' && !phoneMode && phoneForm && (
          <form className="pair-form" onSubmit={startPairing}>
            <label htmlFor="wa-phone">WhatsApp number to link <span className="hint">(with country code)</span></label>
            <input
              id="wa-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="e.g. +91 98765 43210"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              disabled={busy}
            />
            <div className="pair-actions">
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Starting…' : 'Get linking code'}</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setPhoneForm(false)}>Cancel</button>
            </div>
          </form>
        )}
        {canManage && phoneMode && (
          <button className="btn ghost" style={{ marginTop: 14 }} disabled={busy} onClick={backToQr}>
            {busy ? 'Switching…' : '🔳 Use QR code instead'}
          </button>
        )}
        <div className="banner">🔒 <strong>Safe mode</strong>: if tester numbers are configured, the bot only replies to those.</div>
      </div>
    </div>
  );
}

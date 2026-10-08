import axios from 'axios';
import config from '../config/config.js';

/**
 * Transactional email through Brevo's HTTP API (https://developers.brevo.com/reference/sendtransacemail).
 * Plain axios — no SDK dependency for one endpoint.
 *
 * Used to send staff their admin-console login details. Sending never throws: an email
 * failure must not undo the account change that triggered it, so callers get
 * { sent:false, error } and show it to the owner, who can share the details by hand.
 */

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function consoleLoginUrl() {
  return config.adminConsoleUrl || `${config.baseUrl.replace(/\/+$/, '')}/admin`;
}

function accessEmail({ name, email, password, roleName, sentBy, kind }) {
  const url = consoleLoginUrl();
  const isNew = kind === 'created';
  const subject = isNew ? 'Your Aurax admin console login' : 'Your Aurax admin console password has changed';
  const intro = isNew
    ? `${escapeHtml(sentBy)} has given you access to the Aurax admin console as <strong>${escapeHtml(roleName)}</strong>.`
    : `${escapeHtml(sentBy)} has set a new password for your Aurax admin console account. Your old password no longer works, and you have been signed out everywhere.`;
  const introText = isNew
    ? `${sentBy} has given you access to the Aurax admin console as ${roleName}.`
    : `${sentBy} has set a new password for your Aurax admin console account. Your old password no longer works, and you have been signed out everywhere.`;

  const row = (label, value, mono = false) => `
    <tr>
      <td style="padding:10px 0;color:#6c7280;font-size:13px;font-weight:600;width:120px;vertical-align:top;">${label}</td>
      <td style="padding:10px 0;color:#1b1f2a;font-size:14px;font-weight:700;word-break:break-all;${mono ? "font-family:'SFMono-Regular',Consolas,'Courier New',monospace;letter-spacing:.5px;" : ''}">${value}</td>
    </tr>`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e7e9ee;border-radius:14px;overflow:hidden;">
        <tr><td style="background:#0b0d10;padding:20px 28px;">
          <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:1px;">AURAX</div>
          <div style="color:#9aa0ac;font-size:12px;font-weight:500;margin-top:2px;">Admin console</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 12px;color:#1b1f2a;font-size:15px;">Hi ${escapeHtml(name)},</p>
          <p style="margin:0 0 20px;color:#1b1f2a;font-size:14px;line-height:1.6;">${intro}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafbfc;border:1px solid #e7e9ee;border-radius:10px;padding:6px 18px;">
            ${row('Sign-in page', `<a href="${escapeHtml(url)}" style="color:#0e7a4b;">${escapeHtml(url)}</a>`)}
            ${row('Email', escapeHtml(email))}
            ${row('Password', escapeHtml(password), true)}
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
            <tr><td style="background:#0e7a4b;border-radius:10px;">
              <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Open the admin console</a>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;color:#6c7280;font-size:12.5px;line-height:1.6;">
            Keep these details private and don't forward this email. You'll only see the pages your role allows.
            If you weren't expecting this, tell the store owner.
          </p>
        </td></tr>
        <tr><td style="border-top:1px solid #e7e9ee;padding:14px 28px;color:#9aa0ac;font-size:11.5px;">
          Sent automatically by the Aurax admin console.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${name},`,
    '',
    introText,
    '',
    `Sign-in page: ${url}`,
    `Email: ${email}`,
    `Password: ${password}`,
    '',
    'Keep these details private and don\'t forward this email. If you weren\'t expecting this, tell the store owner.',
  ].join('\n');

  return { subject, html, text };
}

class MailService {
  isConfigured() {
    return !!(config.mail.brevoApiKey && config.mail.fromEmail);
  }

  /**
   * Email someone their console login.
   * @param {{ name, email, password, roleName, sentBy, kind: 'created'|'password' }} details
   * @returns {Promise<{ sent: true, messageId } | { sent: false, error }>}
   */
  async sendAccessEmail(details) {
    if (!this.isConfigured()) {
      return { sent: false, error: 'Email isn\'t set up on the server (BREVO_API_KEY and MAIL_FROM_EMAIL).' };
    }
    const { subject, html, text } = accessEmail(details);
    try {
      const res = await axios.post(BREVO_SEND_URL, {
        sender: { name: config.mail.fromName, email: config.mail.fromEmail },
        to: [{ email: details.email, name: details.name }],
        subject,
        htmlContent: html,
        textContent: text,
        // Lets these be filtered in Brevo's transactional logs.
        tags: ['admin-access'],
      }, {
        headers: { 'api-key': config.mail.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
        timeout: 15000,
      });
      // Never log the password — server logs are visible on the Monitor page.
      console.log(`[Mail] Sent ${details.kind === 'created' ? 'new-account' : 'password-change'} email to ${details.email} (${res.data?.messageId || 'no id'}).`);
      return { sent: true, messageId: res.data?.messageId || null };
    } catch (err) {
      const status = err.response?.status;
      const reason = err.response?.data?.message || err.message;
      console.error(`[Mail] Brevo send to ${details.email} failed${status ? ` (${status})` : ''}: ${reason}`);
      let error = `Brevo: ${reason}`;
      if (status === 401) error = 'Brevo rejected the API key (BREVO_API_KEY).';
      else if (/sender/i.test(reason)) error = `Brevo: ${reason} — verify MAIL_FROM_EMAIL under Senders in Brevo.`;
      return { sent: false, error };
    }
  }
}

const mailService = new MailService();
export default mailService;

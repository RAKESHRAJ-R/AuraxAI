// Where the bot's Express API lives.
//
// Empty (the default) = same origin, which is what both the Vite dev proxy and the
// self-hosted /admin build want. Vercel serves the console from a different origin
// than the bot, so its deploys set VITE_API_BASE_URL to the bot's public HTTPS URL
// (e.g. https://bot.theaurax.in) and every request below becomes absolute.
//
// Anything cross-origin also needs that origin allowlisted in the bot's
// ADMIN_ALLOWED_ORIGINS, or the browser blocks the response.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

// Join the configured base with an app-relative path like '/api/sessions'.
// Every network call in the console must go through this — a bare fetch('/api/…')
// silently hits the Vercel domain, which has no API and returns the SPA's index.html.
export function apiUrl(path) {
  return API_BASE + path;
}

// Small fetch wrapper bound to the current auth token. Every admin API call
// goes through this so the bearer token is attached and 401s trigger logout.
export function makeApi(token, onAuthFail) {
  return async (path, opts = {}) => {
    const res = await fetch(apiUrl(path), {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) {
      onAuthFail();
      throw new Error('Session expired — please sign in again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
}

// Human-friendly relative timestamp ("3m ago", "2h ago").
export function relTime(iso) {
  if (!iso) return 'Never';
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  const h = Math.floor(mins / 60);
  if (h < 24) return h + 'h ago';
  return new Date(iso).toLocaleDateString();
}

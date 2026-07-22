// Small fetch wrapper bound to the current auth token. Every admin API call
// goes through this so the bearer token is attached and 401s trigger logout.
export function makeApi(token, onAuthFail) {
  return async (path, opts = {}) => {
    const res = await fetch(path, {
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

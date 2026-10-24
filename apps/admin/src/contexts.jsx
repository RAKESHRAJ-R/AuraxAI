import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import { makeApi, apiUrl } from './api.js';

const TOKEN_KEY = 'theaurax_admin_token';
const USER_KEY = 'theaurax_admin_user';
// Left behind by the old shared-team-password login. Cleared so a stale value can't linger.
['theaurax_admin_team', 'theaurax_admin_team_label'].forEach((k) => localStorage.removeItem(k));

const AuthCtx = createContext(null);
const ToastCtx = createContext(() => {});

export function useAuth() {
  return useContext(AuthCtx);
}
export function useToast() {
  return useContext(ToastCtx);
}

function readStoredUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)) || null; } catch { return null; }
}

// Single provider that supplies auth (token, signed-in user, permission check, bound api
// helper) and a toast function to the whole tree, and renders the toast element itself.
export function AppProviders({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [user, setUser] = useState(readStoredUser);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), err ? 4000 : 2400);
  }, []);

  const saveUser = useCallback((u) => {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
  }, []);

  // Local only — used when the server has already rejected the token.
  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken('');
    setUser(null);
  }, []);

  const logout = useCallback(() => {
    // Best effort: end the session server-side too, so the token is dead even if copied.
    if (token) {
      fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
    }
    clearSession();
  }, [token, clearSession]);

  const login = useCallback((t, u) => {
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
    saveUser(u);
  }, [saveUser]);

  const api = useMemo(() => makeApi(token, clearSession), [token, clearSession]);

  // Re-read the account on load and every minute, so a role change made by the owner shows
  // up without signing out — and a disabled account is sent back to the sign-in page.
  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    const load = () => api('/api/auth/me').then((u) => alive && saveUser(u)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [token, api, saveUser]);

  const can = useCallback(
    (perm) => !!user?.permissions && (user.permissions.includes('*') || user.permissions.includes(perm)),
    [user]
  );

  const auth = useMemo(
    () => ({ token, user, can, api, login, logout }),
    [token, user, can, api, login, logout]
  );

  return (
    <AuthCtx.Provider value={auth}>
      <ToastCtx.Provider value={showToast}>
        {children}
        {toast && <div className={'toast ' + (toast.err ? 'err' : 'ok')}>{toast.msg}</div>}
      </ToastCtx.Provider>
    </AuthCtx.Provider>
  );
}

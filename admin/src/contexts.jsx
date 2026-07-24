import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { makeApi } from './api.js';

const TOKEN_KEY = 'theaurax_admin_token';
const TEAM_KEY = 'theaurax_admin_team';
const LABEL_KEY = 'theaurax_admin_team_label';

const AuthCtx = createContext(null);
const ToastCtx = createContext(() => {});

export function useAuth() {
  return useContext(AuthCtx);
}
export function useToast() {
  return useContext(ToastCtx);
}

// Single provider that supplies auth (token + bound api helper) and a toast
// function to the whole tree, and renders the toast element itself.
export function AppProviders({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [team, setTeam] = useState(() => localStorage.getItem(TEAM_KEY) || '');
  const [teamLabel, setTeamLabel] = useState(() => localStorage.getItem(LABEL_KEY) || '');
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 2400);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TEAM_KEY);
    localStorage.removeItem(LABEL_KEY);
    setToken('');
    setTeam('');
    setTeamLabel('');
  }, []);

  const login = useCallback((t, tm = '', label = '') => {
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(TEAM_KEY, tm);
    localStorage.setItem(LABEL_KEY, label);
    setToken(t);
    setTeam(tm);
    setTeamLabel(label);
  }, []);

  const api = useMemo(() => makeApi(token, logout), [token, logout]);
  const auth = useMemo(
    () => ({ token, team, teamLabel, api, login, logout }),
    [token, team, teamLabel, api, login, logout]
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

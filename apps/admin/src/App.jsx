import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts.jsx';
import { SECTIONS } from './sections.js';
import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Monitor from './pages/Monitor.jsx';
import WhatsApp from './pages/WhatsApp.jsx';
import Knowledge from './pages/Knowledge.jsx';
import Tickets from './pages/Tickets.jsx';
import Users from './pages/Users.jsx';
import Activity from './pages/Activity.jsx';

const PAGES = { monitor: Monitor, whatsapp: WhatsApp, knowledge: Knowledge, tickets: Tickets, users: Users, activity: Activity };

export default function App() {
  const { token, user, can, logout } = useAuth();

  // One login gates the entire console.
  if (!token) return <Login />;

  // Token from a previous visit, account not loaded yet.
  if (!user) {
    return <div className="login-page"><div className="spinner" /></div>;
  }

  // Only pages the role grants get a route at all; anything else lands on the first allowed page.
  const allowed = SECTIONS.filter((s) => can(s.perm));

  if (allowed.length === 0) {
    return (
      <div className="login-page">
        <div className="card login-card fade">
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>No pages assigned yet</h2>
          <p className="desc">
            Your account ({user.email}) is signed in, but your role doesn't include any pages.
            Ask the store owner to update your role.
          </p>
          <button className="btn ghost" style={{ width: '100%', marginTop: 16 }} onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <Layout sections={allowed}>
      <Routes>
        {allowed.map((s) => {
          const Page = PAGES[s.id];
          return <Route key={s.id} path={'/' + s.id} element={<Page />} />;
        })}
        <Route path="*" element={<Navigate to={'/' + allowed[0].id} replace />} />
      </Routes>
    </Layout>
  );
}

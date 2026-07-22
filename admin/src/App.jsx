import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts.jsx';
import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Monitor from './pages/Monitor.jsx';
import WhatsApp from './pages/WhatsApp.jsx';
import Knowledge from './pages/Knowledge.jsx';

export default function App() {
  const { token } = useAuth();

  // One login gates the entire console — Monitor, WhatsApp, and Knowledge Hub.
  if (!token) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/monitor" replace />} />
        <Route path="/monitor" element={<Monitor />} />
        <Route path="/whatsapp" element={<WhatsApp />} />
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="*" element={<Navigate to="/monitor" replace />} />
      </Routes>
    </Layout>
  );
}

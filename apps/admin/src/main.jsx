import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProviders } from './contexts.jsx';
import App from './App.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/*
      basename must track vite's `base`, which differs per target: '/' for the Vercel
      deploy, '/admin/' for the build Express serves. import.meta.env.BASE_URL is
      literally that value, so this stays correct for both without a second knob.
    */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AppProviders>
        <App />
      </AppProviders>
    </BrowserRouter>
  </React.StrictMode>
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// PWA (F19): register the service worker so the portal installs and cold-loads
// offline. A waiting worker is announced via a window event AND stashed, so the
// toast still appears if the update resolves before PwaPrompts has mounted.
serviceWorkerRegistration.register({
  onUpdate: (registration) => {
    window.__pwaWaitingRegistration = registration;
    window.dispatchEvent(new CustomEvent('pwa:update-ready', { detail: registration }));
  },
});

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import { applyTheme, cachedThemeId } from './lib/themes';

// Apply the last-used theme before first paint so reloads don't flash the default.
// The server-persisted theme reconciles once the workspace loads (see App boot).
applyTheme(cachedThemeId());

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

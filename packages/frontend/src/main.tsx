import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Popout } from './Popout';
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import { applyTheme, cachedThemeId } from './lib/themes';
import { popoutRunId } from './lib/desktop';

// Apply the last-used theme before first paint so reloads don't flash the default.
// The server-persisted theme reconciles once the workspace loads (see App boot).
applyTheme(cachedThemeId());

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

// A pop-out window (opened with `?popout=<runId>` by the desktop shell) shows a
// single detached terminal instead of the full app.
const popout = popoutRunId();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>{popout ? <Popout runId={popout} /> : <App />}</React.StrictMode>,
);

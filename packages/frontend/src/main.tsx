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

// Pop-out windows opened by the desktop shell render a single piece full-window:
//   ?popout=<runId>   → one detached terminal. Anything else is the full app.
const popout = popoutRunId();

function Root() {
  if (popout) return <Popout runId={popout} />;
  return <App />;
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

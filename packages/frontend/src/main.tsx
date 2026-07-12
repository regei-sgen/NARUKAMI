import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Popout } from './Popout';
import { BrowserView, SingleViewport } from './components/BrowserView';
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
//   ?popout=<runId>                                → one detached terminal
//   ?popout=browser&project=<id>                   → the project's Browser board
//   ?popout=viewport&project=&browser=&vp=<id>     → one device viewport
// Anything else is the full app.
const params = new URLSearchParams(window.location.search);
const popout = popoutRunId();
const projectId = params.get('project');

function Root() {
  if (popout === 'browser' && projectId) {
    return (
      <div className="popout-app">
        <BrowserView projectId={projectId} />
      </div>
    );
  }
  if (popout === 'viewport' && projectId) {
    const browserId = params.get('browser');
    const vpId = params.get('vp');
    if (browserId && vpId) {
      return (
        <div className="popout-app">
          <SingleViewport projectId={projectId} browserId={browserId} vpId={vpId} />
        </div>
      );
    }
  }
  if (popout) return <Popout runId={popout} />;
  return <App />;
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

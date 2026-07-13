import React from 'react';
import ReactDOM from 'react-dom/client';
// Bundled webfonts — the design faces render everywhere instead of silently
// falling back to whatever the machine has installed.
import '@fontsource/ubuntu-mono/400.css';
import '@fontsource/ubuntu-mono/700.css';
import '@fontsource/kaushan-script/400.css'; // wordmark brush calligraphy
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import App from './App';
import { Popout } from './Popout';
import { MobileTerminal } from './MobileTerminal';
import { IconDefs } from './components/icons';
import './styles.css';
import './components/argus/argus.css';
import '@xterm/xterm/css/xterm.css';
import { popoutRunId } from './lib/desktop';

// Apply the last-used theme variant before first paint so reloads don't flash the
// default. Uses the SAME [data-theme] mechanism + storage key ('narukami-theme') as
// App/ThemeSelector. NOTE: writing inline CSS custom-props here (the old applyTheme
// from lib/themes) put them on <html>, which overrides the :root[data-theme='…']
// rules in styles.css and froze the accent — that dead-locked the header picker.
const savedTheme = localStorage.getItem('narukami-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

// Entry routing (all off the URL query, so no router dependency):
//  - `?m=<shareToken>&run=<runId>` → a phone opened a shared terminal over the
//    LAN relay. Show the single-terminal mobile view (tokenless, share-scoped).
//  - `?popout=<runId>` → the desktop shell tore a terminal into its own window.
//  - otherwise → the full app.
const params = new URLSearchParams(window.location.search);
const shareToken = params.get('m');
const shareRun = params.get('run');
const popout = popoutRunId();

// The phone page is served over plain HTTP on a LAN IP — NOT a secure context —
// so navigator.clipboard doesn't exist there. Monaco (bundled into this same
// SPA chunk) registers a focus-driven clipboard hook at module scope and crashes
// on `clipboard.write` the moment the terminal is focused. Shim a no-op
// clipboard so focusing/typing on the shared terminal doesn't throw.
if (shareToken && !('clipboard' in navigator)) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: () => Promise.resolve(),
      writeText: () => Promise.resolve(),
      read: () => Promise.reject(new Error('Clipboard unavailable over LAN HTTP.')),
      readText: () => Promise.reject(new Error('Clipboard unavailable over LAN HTTP.')),
    },
  });
}
// ClipboardItem is secure-context-only too, and Monaco `new`s it in the same
// focus hook — give it an inert stand-in as well.
if (shareToken && typeof window.ClipboardItem === 'undefined') {
  (window as unknown as { ClipboardItem: unknown }).ClipboardItem = class {
    constructor(public items: unknown) {}
  };
}

const view =
  shareToken && shareRun ? (
    <MobileTerminal runId={shareRun} shareToken={shareToken} />
  ) : popout ? (
    <Popout runId={popout} />
  ) : (
    <App />
  );

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <IconDefs />
    {view}
  </React.StrictMode>,
);

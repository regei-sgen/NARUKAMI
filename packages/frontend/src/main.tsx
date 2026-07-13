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
import { IconDefs } from './components/icons';
import './styles.css';
import './components/argus/argus.css';
import '@xterm/xterm/css/xterm.css';
// Apply the last-used theme variant before first paint so reloads don't flash the
// default. Uses the SAME [data-theme] mechanism + storage key ('narukami-theme') as
// App/ThemeSelector. NOTE: writing inline CSS custom-props here (the old applyTheme
// from lib/themes) put them on <html>, which overrides the :root[data-theme='…']
// rules in styles.css and froze the accent — that dead-locked the header picker.
const savedTheme = localStorage.getItem('narukami-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <IconDefs />
    <App />
  </React.StrictMode>,
);

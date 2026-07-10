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

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <IconDefs />
    <App />
  </React.StrictMode>,
);

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server bound to localhost only, on the fixed port the backend allow-lists.
export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom so both api-layer tests (which touch `window`) and React component
    // tests can run. The node env silently failed api.test.ts on `window`.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
  },
});

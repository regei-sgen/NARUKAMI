import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These pure-unit tests never touch Postgres or spawn processes.
    passWithNoTests: false,
  },
});

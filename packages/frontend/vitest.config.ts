import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Logic/unit tests (api layer, pure helpers) — no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

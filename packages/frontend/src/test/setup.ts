import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests so component tests don't leak DOM into each other.
afterEach(() => {
  cleanup();
});

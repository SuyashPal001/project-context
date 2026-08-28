import { defineConfig } from 'vitest/config';

// Pure-function unit tests only (e.g. scripts/cycleEnd.test.ts) - no DB, no env wiring.
export default defineConfig({
  test: {
    name: 'database',
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
  },
});

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'agent-orchestrator',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // packages/foundation/database/client.ts reads DATABASE_URL at import
    // time. Point it at TEST_DATABASE_URL (never the shared dev DB — see
    // CLAUDE.md) so the credit_rates-cache test in cost.test.ts can exercise
    // a real DB; when TEST_DATABASE_URL is unset, vitest.setup.ts's
    // placeholder still applies and that describe block skips itself.
    env: {
      ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
    },
  },
})

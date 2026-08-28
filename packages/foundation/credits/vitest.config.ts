import { defineConfig } from 'vitest/config'

// The read/spend/grant wrappers go through the shared `db` singleton from
// @serverless-saas/database, which reads DATABASE_URL at import time. The
// integration tests are invoked with TEST_DATABASE_URL (see CLAUDE.md - never
// let a script default onto the shared dev DATABASE_URL from apps/api/.env),
// so point DATABASE_URL at it for this process only, before any test module
// (and therefore the db client) is imported. When TEST_DATABASE_URL is unset
// the integration describe blocks skip themselves and no DB is touched.
export default defineConfig({
  test: {
    name: 'credits',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
    },
  },
})

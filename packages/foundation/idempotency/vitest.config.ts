import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'idempotency',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

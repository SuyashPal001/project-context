import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'credits',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

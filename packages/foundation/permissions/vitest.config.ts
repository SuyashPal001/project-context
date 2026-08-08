import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'permissions',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'mcp-server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

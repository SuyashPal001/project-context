import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'inference-gateway',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

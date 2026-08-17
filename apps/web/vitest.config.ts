import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    name: 'web',
    environment: 'node',
    include: ['{lib,components,hooks}/**/*.test.ts'],
  },
})

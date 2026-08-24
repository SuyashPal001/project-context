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
    // Default stays node so the existing lib/hooks tests are unaffected.
    // Component tests opt in per-file with a `@vitest-environment jsdom`
    // docblock. globals is on so React Testing Library's auto-cleanup runs
    // between tests.
    environment: 'node',
    globals: true,
    include: ['{lib,components,hooks}/**/*.test.{ts,tsx}'],
  },
})

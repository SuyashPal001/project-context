import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

// Load from apps/api/.env for local dev
dotenv.config({ path: '../../../apps/api/.env' });

export default defineConfig({
  schema: [
    './schema/index.ts',
    '../../../products/agent-platform/packages/schema/index.ts',
  ],
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});

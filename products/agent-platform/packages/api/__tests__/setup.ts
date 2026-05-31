// Test env stubs. Tests mock the DB anyway; these placeholders just satisfy
// module-load checks like `process.env.DATABASE_URL!.includes(...)` in
// @serverless-saas/database/client.ts.
// Local postgres URL — matches prod (Neon was removed; everything is local PG now).
// The DB is fully mocked in tests via vi.mock('drizzle-orm/postgres-js') etc.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.AWS_REGION ??= 'ap-south-1';

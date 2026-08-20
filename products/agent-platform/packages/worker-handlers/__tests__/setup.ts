// Test env stubs — the DB is mocked per-test; this just satisfies module-load
// checks in @serverless-saas/database/client.ts. Mirrors agent-api's own setup.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.AWS_REGION ??= 'ap-south-1';
process.env.DOCUMENTS_BUCKET ??= 'test-documents-bucket';

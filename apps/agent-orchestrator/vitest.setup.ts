// packages/foundation/database/client.ts dereferences DATABASE_URL at module
// load, so any suite that transitively imports it crashes during collection
// when the variable is unset. postgres.js connects lazily, so a placeholder is
// enough to let modules load; nothing here opens a socket.
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'

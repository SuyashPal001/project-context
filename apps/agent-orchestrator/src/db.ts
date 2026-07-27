import pg from 'pg'
import { resolvedDbHost, isNeonDb, dbUrl } from './mastra/memory.js'

// Shared pg.Pool factory for all orchestrator services.
// On Neon (production), uses the pre-resolved IPv4 host to avoid Node.js v22
// Happy Eyeballs probing all 6 DNS addresses (3 IPv4 + 3 IPv6 concurrently);
// the GCP VM has no IPv6 route to AWS so all IPv6 attempts return ENETUNREACH
// and all IPv4 attempts can timeout under load.
export function makeAppPool(max = 5): pg.Pool {
  if (isNeonDb) {
    return new pg.Pool({
      host: resolvedDbHost,
      port: Number(dbUrl.port) || 5432,
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      database: dbUrl.pathname.slice(1),
      ssl: { servername: dbUrl.hostname, rejectUnauthorized: false },
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  }
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}

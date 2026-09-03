import { PostgresStore, PgVector } from '@mastra/pg'
import { Memory } from '@mastra/memory'
import pg from 'pg'
import dns from 'dns/promises'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

// Separate pg.Pool for Mastra
// Does NOT use our Drizzle connection
// All 33 Mastra tables land in 'mastra' schema
// Zero collision with application tables

// Node.js 22 Happy Eyeballs tries all 6 Neon DNS addresses (3 IPv4 + 3 IPv6)
// concurrently and ETIMEDOUT because the GCP VM has no IPv6 route to AWS.
// Fix: top-level await on DNS resolution so makePool() can use a single IPv4
// address synchronously. The module won't finish loading until DNS resolves,
// so platformAgent.ts's getMastraMemory() call will always see a ready pool.
const _dbUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/db')
const _isNeon = _dbUrl.hostname.includes('.neon.tech')
const _isSupabase = _dbUrl.hostname.includes('.supabase.com')

const _resolvedHost: string = _isNeon
  ? (await dns.resolve4(_dbUrl.hostname).then(addrs => addrs[0]).catch(() => _dbUrl.hostname))
  : _dbUrl.hostname

// Exported for other pools in the orchestrator that also need the IPv4 fix.
export const resolvedDbHost: string = _resolvedHost
export const isNeonDb: boolean = _isNeon
export const dbUrl: URL = _dbUrl

function makePool(max: number): pg.Pool {
  if (_isNeon) {
    return new pg.Pool({
      host: _resolvedHost,
      port: Number(_dbUrl.port) || 5432,
      user: decodeURIComponent(_dbUrl.username),
      password: decodeURIComponent(_dbUrl.password),
      database: _dbUrl.pathname.slice(1),
      ssl: { servername: _dbUrl.hostname, rejectUnauthorized: false },
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  }
  if (_isSupabase) {
    return new pg.Pool({
      host: _dbUrl.hostname,
      port: Number(_dbUrl.port) || 5432,
      user: decodeURIComponent(_dbUrl.username),
      password: decodeURIComponent(_dbUrl.password),
      database: _dbUrl.pathname.slice(1),
      ssl: { rejectUnauthorized: false },
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

let store: PostgresStore | null = null
let vector: PgVector | null = null
let memory: Memory | null = null

export function getMastraStore(): PostgresStore {
  if (!store) {
    store = new PostgresStore({ id: 'mastra-pg-store', pool: makePool(5), schemaName: 'mastra' })
  }
  return store
}

export function getMastraVector(): PgVector {
  if (!vector) {
    if (_isNeon || _isSupabase) {
      const resolved = new URL(_dbUrl.toString())
      if (_isNeon) resolved.hostname = _resolvedHost
      // Disable strict TLS for Neon/Supabase self-signed cert chains
      resolved.searchParams.set('sslmode', 'no-verify')
      vector = new PgVector({ id: 'mastra-pg-vector', connectionString: resolved.toString() })
    } else {
      vector = new PgVector({ id: 'mastra-pg-vector', connectionString: process.env.DATABASE_URL! })
    }
  }
  return vector
}

// Embedder — routes through the Inference Gateway (same as LLM models).
const google = createGoogleGenerativeAI({
  baseURL: (process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001') + '/v1',
  apiKey: process.env.INTERNAL_SERVICE_KEY ?? '',
})
export const embedder = google.embedding('gemini-embedding-001')

// Query pool for direct mastra schema access (truncation, etc.)
let _mastraQueryPool: pg.Pool | null = null
function getMastraQueryPool(): pg.Pool {
  if (!_mastraQueryPool) _mastraQueryPool = makePool(2)
  return _mastraQueryPool
}

// Delete all Mastra messages for a thread that were created at or after fromTimestamp.
// Uses memory.deleteMessages() so vector embeddings are also cleaned up.
export async function truncateMastraThread(conversationId: string, fromTimestamp: Date): Promise<number> {
  const res = await getMastraQueryPool().query<{ id: string }>(
    `SELECT id FROM mastra.mastra_messages
     WHERE thread_id = $1 AND "createdAt" >= $2`,
    [conversationId, fromTimestamp]
  )
  if (res.rows.length === 0) return 0
  const ids = res.rows.map(r => r.id)
  await getMastraMemory().deleteMessages(ids)
  return ids.length
}

// Singleton Memory instance — shared across all tenants.
// Isolation is enforced per-request via resourceId (MASTRA_RESOURCE_ID_KEY)
// set on the RequestContext before each generate() call.
export function getMastraMemory(): Memory {
  if (memory) return memory

  memory = new Memory({
    storage: getMastraStore(),
    vector: getMastraVector(),
    embedder,
    options: {
      lastMessages: 20,
      semanticRecall: {
        topK: 3,
        messageRange: 2,
      },
      workingMemory: {
        enabled: true,
        template: `# Tenant Context
- Product Name:
- Industry:
- Tech Stack:
- Team Size:
- Current Phase: [PRD | Roadmap | Tasks | Done]
- Active PRD ID:
- Active Plan ID:

# User Preferences
- PRD Style: [technical | business | brief]
- Milestone Detail: [detailed | summary]
- Preferred Priority Scheme: [conservative | aggressive]
- Communication Style: [formal | casual]

# Key Decisions
- [Decision 1]
- [Decision 2]
`,
      },
    },
  })

  return memory
}

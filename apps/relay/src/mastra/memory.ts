import { PostgresStore, PgVector } from '@mastra/pg'
import { Memory } from '@mastra/memory'
import pg from 'pg'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

// Separate pg.Pool for Mastra
// Does NOT use our Drizzle connection
// All 33 Mastra tables land in 'mastra' schema
// Zero collision with application tables

let store: PostgresStore | null = null
let vector: PgVector | null = null
let memory: Memory | null = null

export function getMastraStore(): PostgresStore {
  if (store) return store

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5, // small pool — Mastra only
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })

  store = new PostgresStore({
    id: 'mastra-pg-store',
    pool,
    schemaName: 'mastra',
  })

  return store
}

function getMastraVector(): PgVector {
  if (vector) return vector
  vector = new PgVector({ id: 'mastra-pg-vector', connectionString: process.env.DATABASE_URL! })
  return vector
}

// Embedder — reuses the same vertex-proxy as the LLM models.
const google = createGoogleGenerativeAI({
  baseURL: (process.env.VERTEX_PROXY_URL ?? 'http://localhost:4001') + '/v1',
  apiKey: process.env.GEMINI_API_KEY ?? 'placeholder',
})
const embedder = google.embedding('gemini-embedding-001')

// Singleton Memory instance — shared across all tenants.
// Isolation is enforced per-request via resourceId (MASTRA_RESOURCE_ID_KEY)
// set on the RequestContext before each generate() call.
// Created once at startup; never recreated per request.
export function getMastraMemory(): Memory {
  if (memory) return memory

  memory = new Memory({
    storage: getMastraStore(),
    vector: getMastraVector(),
    embedder,
    options: {
      lastMessages: 10,
      semanticRecall: {
        enabled: true,
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

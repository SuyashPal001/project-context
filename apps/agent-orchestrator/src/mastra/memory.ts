import { PostgresStore, PostgresStoreVNext, PgVector } from '@mastra/pg'
import { Memory, Extractor } from '@mastra/memory'
import { z } from 'zod'
import pg from 'pg'
import dns from 'dns/promises'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { memoryModel, liteModel } from './model.js'

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

let store: PostgresStoreVNext | null = null
let vector: PgVector | null = null
let memory: Memory | null = null
// Separate from `memory` above — Olmo's instance differs in scope, not wiring.
// See getOlmoMemory().
let olmoMemory: Memory | null = null

export function getMastraStore(): PostgresStoreVNext {
  if (!store) {
    store = new PostgresStoreVNext({
      id: 'mastra-pg-store',
      pool: makePool(5),
      schemaName: 'mastra',
      observability: { pool: makePool(3), schemaName: 'mastra' },
    })
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

// Count messages in a Mastra thread. Used by chatStream.ts to skip semantic
// recall on short threads: with `lastMessages: 20`, a recall lookup over a
// ≤20-message thread can only return content already in the loaded window,
// so the pgvector similarity search (measured 2.7–5.4s per turn) is dead
// weight. Returns 0 on error — callers treat "unknown" as "short" and
// short-circuit recall the same way, which errs toward faster responses.
export async function countThreadMessages(threadId: string): Promise<number> {
  try {
    const res = await getMastraQueryPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mastra.mastra_messages WHERE thread_id = $1`,
      [threadId],
    )
    return Number(res.rows[0]?.count ?? 0)
  } catch {
    return 0
  }
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

// Working-memory template shared by the memory instances below. Extracted so
// Olmo's dedicated instance and the shared one cannot drift apart on content
// while deliberately differing on scope.
const WORKING_MEMORY_TEMPLATE = `# Brand Context
- Brand Name:
- Industry:
- Brand Voice / Tone:
- Default Aspect Ratio:
- Default Duration:
- Standing Exclusions: [e.g. no competitor branding, no identifiable people]

# Active Job
- Active Template ID:
- Casting Choice: [library avatar | uploaded reference | generated character]
- Locked Reference Artifact IDs:

# User Preferences
- Casting Source: [library-first | always-generate]
- Deep Analysis Default: [skip when contract covers it | always run]
- Approval Mode: [per-gate | approve-plan-once]
- Communication Style: [formal | casual]

# Credit Status
- Plan Tier:
- Credit Balance:

# Key Decisions
- [Decision 1]
- [Decision 2]
`

// OM extractor feeding the future tenant-level memory UI (see
// project_agent_memory_ui_design memory note). Distinct from workingMemory
// above: workingMemory is small fixed-shape state the agent itself edits via
// tool calls every turn; this extractor is OM's own follow-up structured-output
// call, run automatically after each observation, that pulls a growing,
// categorized list of durable facts out of the compressed observation log —
// no agent tool call involved. Buckets mirror the Profile/Topics/Areas/Projects
// shape from the Claude.ai Memory settings screenshot the redesign is modeled on.
// @mastra/memory bundles its own zod@4.4.3 internally, distinct from this
// repo's zod@3.24 dependency — Extractor's `schema` field types against that
// internal v4 ZodType, which our v3 schema doesn't structurally satisfy even
// though both are ordinary zod schemas at runtime. Cast at this boundary
// rather than bumping the whole app to zod v4.
const tenantMemorySchema = z.object({
  topics: z.array(z.string()).optional().describe('Recurring subjects the tenant cares about (e.g. "pricing strategy", "onboarding flow")'),
  areas: z.array(z.string()).optional().describe('Product/business areas referenced across conversations (e.g. "billing", "mobile app")'),
  projects: z.array(z.string()).optional().describe('Named projects, features, or initiatives mentioned (e.g. "Q3 roadmap", "auth migration")'),
})

const tenantMemoryExtractor = new Extractor({
  name: 'Tenant memory',
  instructions:
    'Extract durable, reusable facts about this tenant\'s product, team, and working ' +
    'preferences that should carry into future conversations. Do not extract one-off ' +
    'task details or anything already captured in working memory (tech stack, PRD/plan ' +
    'IDs, communication style). Update or drop fields when new information supersedes them.',
  schema: tenantMemorySchema as any,
})

// Singleton Memory instance — shared across all tenants.
// Isolation is enforced per-request via resourceId (MASTRA_RESOURCE_ID_KEY)
// set on the RequestContext before each generate() call.
//
// semanticRecall.scope and workingMemory.scope are deliberately left at
// Mastra's defaults (both 'resource'), which is what gives directorAgent,
// pmAgent and producerAgent their cross-conversation memory — a user's
// preferences and key decisions carry from one conversation to the next.
// Do NOT pin these to 'thread' to satisfy Olmo's delegation safety
// requirement: Olmo has its own instance for that (getOlmoMemory() below),
// precisely so the two concerns cannot be conflated again. An earlier pass
// pinned 'thread' here and silently stripped cross-conversation memory from
// all three standalone agents.
//
// Observational Memory's own `scope` is pinned to 'thread' — Mastra's
// default and the well-tested path — deliberately, for now. The eventual
// goal is 'resource' (matching semanticRecall/workingMemory above, so OM's
// observation log also carries across conversations instead of resetting
// per-thread), but resource scope is marked experimental by Mastra, disables
// async buffering, and processes a tenant's entire unobserved backlog across
// all threads together on first activation. Prove OM out at 'thread' scope
// first, then graduate to 'resource' once validated — don't skip straight to
// the experimental path.
// Native Mastra thread titles (replaces a hand-built one-shot title call in
// chatStream.ts). Runs in the background after the first finished response,
// from the whole exchange so far (user message and reply), and only while the
// thread's title is still empty. Never runs on a turn that suspends for tool
// approval; it runs when the resumed turn finishes. Not applied to threads a
// delegate inherits from Olmo (Mastra forces it off there).
const TITLE_GENERATION = {
  model: liteModel,
  instructions: [
    'Write a title for this chat for a sidebar list.',
    '3 to 6 words naming what the user wants done, e.g. "Red car ad image" or "30s gym reel script".',
    'Plain words only: no quotes, no trailing punctuation, no emoji, not a sentence.',
    'If the user only said hello, name what the reply offered instead of "Greeting".',
    'Use the language the user wrote in.',
  ].join(' '),
}

export function getMastraMemory(): Memory {
  if (memory) return memory

  memory = new Memory({
    storage: getMastraStore(),
    vector: getMastraVector(),
    embedder,
    options: {
      generateTitle: TITLE_GENERATION,
      lastMessages: 20,
      semanticRecall: {
        topK: 3,
        messageRange: 2,
        // gemini-embedding-001 produces 3072-dim vectors; ivfflat (Mastra's
        // default) hard-limits at 2000. HNSW has no such restriction.
        indexConfig: { type: 'hnsw' },
      },
      workingMemory: {
        enabled: true,
        template: WORKING_MEMORY_TEMPLATE,
      },
      observationalMemory: {
        enabled: true,
        model: memoryModel,
        scope: 'thread',
        retrieval: { vector: true, scope: 'thread' },
        observation: {
          extract: [tenantMemoryExtractor],
        },
      },
    },
  })

  return memory
}

// Olmo's (platformAgent's) own Memory instance — separate from the shared
// singleton above for one reason: `scope: 'thread'`.
//
// This is LOAD-BEARING for Olmo's sub-agent delegation, and it is the reason
// this function exists at all rather than reusing getMastraMemory().
//
// When Olmo delegates to pm/architect/director/producer, those delegate
// variants deliberately declare no `memory:` of their own — but that does NOT
// make the delegated call memory-inert. Verified against @mastra/core 1.64
// (dist/agent-DsRUDsS_.js): because the supervisor has memory and the delegate
// does not, Mastra lends THIS instance to the delegate
// (MASTRA_INHERITED_MEMORY_KEY, :35203) and binds it to
// `subAgentResourceId = \`${inputData.resourceId}-${agentName}\`` (:35144) —
// where `inputData.resourceId` is a model-writable sub-agent tool input, and
// the tenant's real resource id (MASTRA_RESOURCE_ID_KEY) has been stripped
// from the delegated context copy (:35117). The delegated turn then writes
// under that id (createThread + saveMessages, :35410).
//
// So a delegated turn WRITES into the shared store under a resource id the
// model can be steered to choose — a prompt injection in retrieved or fetched
// content can influence it, and Olmo ingests exactly that kind of content.
// `subAgentResourceId` has no random component, so under Mastra's DEFAULT
// 'resource' scope two different tenants could both address the same bucket
// by name and read each other's delegated content. Thread scope is what
// closes that: recall and working memory resolve against the delegated
// thread id, which Mastra always gives a random UUID suffix (:35138).
//
// Do not change either scope to 'resource', and do not point platformAgent at
// getMastraMemory() instead. Either one re-opens a cross-tenant read channel.
export function getOlmoMemory(): Memory {
  if (olmoMemory) return olmoMemory

  olmoMemory = new Memory({
    storage: getMastraStore(),
    vector: getMastraVector(),
    embedder,
    options: {
      generateTitle: TITLE_GENERATION,
      lastMessages: 20,
      semanticRecall: {
        topK: 3,
        messageRange: 2,
        // Security boundary — see the note above. Not a tuning knob.
        scope: 'thread',
        // gemini-embedding-001 produces 3072-dim vectors; ivfflat hard-limits
        // at 2000. HNSW has no such restriction.
        indexConfig: { type: 'hnsw' },
      },
      workingMemory: {
        enabled: true,
        // Security boundary — see the note above. Not a tuning knob.
        scope: 'thread',
        template: WORKING_MEMORY_TEMPLATE,
      },
    },
  })

  return olmoMemory
}

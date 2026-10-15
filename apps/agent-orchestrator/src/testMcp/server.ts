// Internal test MCP server: lets Claude Code drive the product on one capped
// test tenant, either by calling Director's tools directly (route 1) or by
// chatting with Olmo as a user (route 2). It exposes real paid tools, so the
// guards come first: localhost only, the shared internal service key on every
// request, tenant/user/conversation from the test identity and never from tool
// arguments, and no startup at all for an unlimited tenant. startTestMcp never
// throws: any failure logs one `[test-mcp] disabled: <reason>` line so the
// orchestrator keeps running without it.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTool } from '@mastra/core/tools'
import { MCPServer } from '@mastra/mcp'
import { isUnlimited } from '@serverless-saas/credits'
import { z } from 'zod'
import { isInternalServiceKey } from '../service-key.js'
import { checkCreditBalance } from '../credits.js'
import { loadTestMcpConfig, type TestMcpConfig } from './config.js'
import { TestIdentity } from './testIdentity.js'
import { ChatDriver } from './chatDriver.js'
import { wrapForTest } from './wrapTool.js'
import { readToolSpans, type ObservabilityLike } from './traces.js'

const INSTRUCTIONS = "Internal test MCP for the Project Context platform. Everything runs on one capped test tenant with real credits. Route 1: call product tools directly. Call test_new_conversation first so files land in one chat. Route 2: olmo_send / olmo_read / olmo_answer chat with Olmo as a user. Pull outputs with get_file and judge them. Read olmo_trace to see what Gemini decided. When a step needs a capability no tool has, stop and log a GAP; don't work around it."

export type TestMcpDeps = {
  identity: TestIdentity
  driver: ChatDriver
  cfg: TestMcpConfig
  traces: ObservabilityLike
  /** Product tools to expose on route 1. startTestMcp passes DIRECTOR_TOOLS. */
  tools: Record<string, any>
  checkBalance?: typeof checkCreditBalance
  /** Used for the API calls this file makes (ownership check, get_file). */
  fetchImpl?: typeof fetch
}

const waitSeconds = z.number().min(0).max(240).optional().describe('How long to wait for the turn to finish or stop at a card (max 240)')

// Mirrors chatDriver's Answer type. The driver also rejects a kind that does
// not match the pending card.
const answerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    answers: z.array(z.object({
      questionIndex: z.number().int().min(0),
      selectedIndex: z.number().int().min(0).optional(),
      selectedIndices: z.array(z.number().int().min(0)).optional(),
      freeText: z.string().optional(),
      skipped: z.boolean().optional(),
    })),
  }),
  z.object({ kind: z.literal('confirm'), decision: z.enum(['approved', 'declined']), reason: z.string().optional() }),
  z.object({ kind: z.literal('approval'), decision: z.enum(['allow', 'deny']) }),
  z.object({ kind: z.literal('upload'), fileIds: z.array(z.string()).optional(), freeText: z.string().optional(), skipped: z.boolean().optional() }),
])

export function buildTestMcpServer(deps: TestMcpDeps): MCPServer {
  const { identity, driver, cfg, traces } = deps
  const checkBalance = deps.checkBalance ?? checkCreditBalance
  const fetchImpl = deps.fetchImpl ?? fetch

  // A conversationId from tool arguments is untrusted. GET /conversations/:id is
  // scoped to tenant + user server-side, so a 200 proves the test user owns it.
  // olmo_trace needs this because the trace store is global (filtered only by
  // threadId); olmo_send needs it because /api/chat lets a message through when
  // ownership comes back 'unknown' (chat.ts), so we must not rely on that.
  const assertOwnConversation = async (conversationId: string): Promise<void> => {
    const token = await identity.idToken()
    const r = await fetchImpl(`${cfg.apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}`, { headers: { Authorization: `Bearer ${token}` } })
    if (r.status !== 200) throw new Error(`conversation ${conversationId} is not the test user's (${r.status})`)
  }

  // The route-1 conversation. Shared by every direct tool call so outputs land
  // in one chat; created lazily once, even under concurrent first calls.
  // `choice` counts explicit test_new_conversation calls: a lazy creation that
  // resolves after an explicit choice must not overwrite it, and of two explicit
  // calls the later one wins.
  let current: string | undefined
  let creating: Promise<string> | undefined
  let choice = 0
  const currentConversation = (): Promise<string> => {
    if (current) return Promise.resolve(current)
    const startedAt = choice
    creating ??= driver.newConversation()
      .then((id) => {
        if (choice === startedAt && !current) current = id
        return current ?? id
      })
      .finally(() => { creating = undefined })
    return creating
  }

  const ctx = async () => ({
    tenantId: cfg.tenantId,
    userId: identity.internalUserId,
    agentId: cfg.agentId,
    conversationId: await currentConversation(),
    idToken: await identity.idToken(),
  })

  const product: Record<string, any> = {}
  for (const [name, tool] of Object.entries(deps.tools)) product[name] = wrapForTest(name, tool, ctx)

  const own = {
    test_status: createTool({
      id: 'test_status',
      description: 'Test tenant, user, agent, remaining credit balance, and the current route-1 conversation.',
      inputSchema: z.object({}),
      execute: async () => {
        const bal = await checkBalance(cfg.tenantId)
        return {
          tenantId: cfg.tenantId,
          userId: identity.internalUserId,
          userSub: identity.userSub,
          agentId: cfg.agentId,
          credits: { balanceMicro: bal.balanceMicro.toString(), unlimited: bal.unlimited, allowed: bal.allowed },
          currentConversationId: current ?? null,
        }
      },
    }),
    test_new_conversation: createTool({
      id: 'test_new_conversation',
      description: 'Start a new auto-mode conversation and make it the one route-1 product tools write into.',
      inputSchema: z.object({}),
      execute: async () => {
        const mine = ++choice
        const id = await driver.newConversation()
        if (mine === choice) current = id
        return { conversationId: id }
      },
    }),
    olmo_send: createTool({
      id: 'olmo_send',
      description: 'Send a chat message to Olmo as the test user. Omit conversationId to start a new chat. Returns the turn state, text, tool calls, files, and any card waiting for an answer.',
      inputSchema: z.object({
        conversationId: z.string().optional(),
        message: z.string().min(1),
        fileIds: z.array(z.string()).optional(),
        waitSeconds,
      }),
      execute: async (a) => {
        if (a.conversationId) await assertOwnConversation(a.conversationId)
        return driver.send(a)
      },
    }),
    olmo_read: createTool({
      id: 'olmo_read',
      description: 'Read the current state of an Olmo chat turn, optionally waiting for it to finish or stop at a card.',
      inputSchema: z.object({ conversationId: z.string(), waitSeconds }),
      execute: async (a) => driver.read(a.conversationId, a.waitSeconds),
    }),
    olmo_answer: createTool({
      id: 'olmo_answer',
      description: 'Answer the card Olmo is waiting on (question, confirm, approval or upload). The answer kind must match the pending card.',
      inputSchema: z.object({ conversationId: z.string(), answer: answerSchema, waitSeconds }),
      execute: async (a) => driver.answer(a.conversationId, a.answer, a.waitSeconds),
    }),
    get_file: createTool({
      id: 'get_file',
      description: 'Get a short-lived download URL for a file in the test tenant, to fetch and judge an output.',
      inputSchema: z.object({ fileId: z.string() }),
      execute: async (a) => {
        const token = await identity.idToken()
        const r = await fetchImpl(`${cfg.apiBaseUrl}/api/v1/files/${encodeURIComponent(a.fileId)}/download`, { headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) throw new Error(`file download ${r.status}: ${await r.text().catch(() => '')}`)
        const json = await r.json() as { data?: { downloadUrl?: string } }
        if (!json.data?.downloadUrl) throw new Error('file download returned no downloadUrl')
        return { downloadUrl: json.data.downloadUrl }
      },
    }),
    olmo_trace: createTool({
      id: 'olmo_trace',
      description: 'Tool and agent spans recorded for a conversation, oldest first: what Gemini decided to call, with inputs, outputs and errors.',
      inputSchema: z.object({ conversationId: z.string(), limit: z.number().int().min(1).max(200).optional() }),
      execute: async (a) => {
        await assertOwnConversation(a.conversationId)
        return { spans: await readToolSpans(traces, a.conversationId, a.limit) }
      },
    }),
  }

  const clash = Object.keys(own).filter((k) => k in product)
  if (clash.length) throw new Error(`product tool names clash with test tools: ${clash.join(', ')}`)

  return new MCPServer({
    id: 'pc-internal-test',
    name: 'Project Context internal test',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    // Stateless revision: one shared handler, legacy clients served by its
    // built-in fallback, so startHTTP needs no session options.
    protocolVersion: '2026-07-28',
    tools: { ...product, ...own },
  })
}

export type StartTestMcpOverrides = Partial<Omit<TestMcpDeps, 'tools'>> & {
  tools?: Record<string, any>
  env?: NodeJS.ProcessEnv
}

// One line, always: errors like drizzle's "Failed query" carry the whole SQL.
function disabled(reason: string): null {
  const line = reason.replace(/\s+/g, ' ').trim()
  console.warn(`[test-mcp] disabled: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`)
  return null
}

export async function startTestMcp(over: StartTestMcpOverrides = {}): Promise<{ port: number; close(): Promise<void> } | null> {
  try {
    let cfg: TestMcpConfig | null
    try {
      cfg = over.cfg ?? loadTestMcpConfig(over.env)
    } catch (err) {
      return disabled((err as Error).message)
    }
    if (!cfg) return null

    let unlimited: boolean
    try {
      unlimited = await isUnlimited(cfg.tenantId)
    } catch (err) {
      return disabled(`credit cap check failed: ${(err as Error).message}`)
    }
    if (unlimited) return disabled('test tenant must have a capped balance')

    const identity = over.identity ?? new TestIdentity(cfg)
    try {
      await identity.init()
    } catch (err) {
      return disabled(`sign-in failed: ${(err as Error).message}`)
    }

    const driver = over.driver ?? new ChatDriver(identity, cfg)
    // Loaded lazily so tests and the disabled path never pull in the agent graph.
    const tools = over.tools ?? (await import('../mastra/agents/directorAgent.js')).DIRECTOR_TOOLS
    let traces = over.traces
    if (!traces) {
      const { mastra } = await import('../mastra/index.js')
      traces = await mastra.getStorage()?.getStore('observability')
      if (!traces) return disabled('no observability store on the mastra instance')
    }

    const server = buildTestMcpServer({ identity, driver, cfg, traces, tools, checkBalance: over.checkBalance, fetchImpl: over.fetchImpl })
    const httpServer = http.createServer(async (req, res) => {
      try {
        // Key first, path second: an unauthenticated caller learns nothing.
        const key = req.headers['x-internal-service-key']
        if (!isInternalServiceKey(typeof key === 'string' ? key : undefined)) { res.writeHead(401).end(); return }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/mcp') { res.writeHead(404).end(); return }
        await server.startHTTP({ url, httpPath: '/mcp', req, res })
      } catch (err) {
        console.warn('[test-mcp] request failed:', (err as Error).message)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      }
    })
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(cfg.port, '127.0.0.1', () => { httpServer.off('error', reject); resolve() })
    })
    // The listen-time reject is gone now; a later server error must only log,
    // never become an unhandled 'error' event that takes the orchestrator down.
    httpServer.on('error', (err) => console.warn('[test-mcp] server error:', err.message))
    const port = (httpServer.address() as AddressInfo).port
    console.log(`[test-mcp] listening on 127.0.0.1:${port}/mcp (tenant ${cfg.tenantId})`)
    return {
      port,
      close: async () => {
        httpServer.closeAllConnections()
        await new Promise<void>((resolve) => httpServer.close(() => resolve()))
        await server.close()
      },
    }
  } catch (err) {
    return disabled((err as Error).message)
  }
}

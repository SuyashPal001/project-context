import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { ModerationProcessor, PIIDetector, PromptInjectionDetector, SystemPromptScrubber } from '@mastra/core/processors'
import { MCPClient } from '@mastra/mcp'
import { z } from 'zod'
import { Exa as ExaClass } from 'exa-js'
import pg from 'pg'

import { platformModel, liteModel, privateModel } from '../model.js'
import { getMastraMemory } from '../memory.js'
import { getMCPClientForTenant } from '../tools.js'
import { createViolationHandler } from '../guardrails.js'
import { makeAppPool } from '../../db.js'

// ---------------------------------------------------------------------------
// Platform prompt — fetched from agentTemplates at request time.
// Queries the latest published template; falls back to static string on error.
// Uses a dedicated small pool — separate from the Mastra internal pool.
// ---------------------------------------------------------------------------

let platformPool: pg.Pool | null = null

function getPlatformPool(): pg.Pool {
  if (!platformPool) {
    platformPool = makeAppPool(2)
    platformPool.on('error', (err) => {
      console.error('[mastra:platform] pool error:', err.message)
    })
  }
  return platformPool
}

// Prompt cache — avoids a DB round-trip on every message.
// TTL: 5 minutes. Invalidated on relay restart.
let _promptCache: { prompt: string; expiresAt: number } | null = null
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchPlatformPrompt(): Promise<string> {
  if (_promptCache && _promptCache.expiresAt > Date.now()) return _promptCache.prompt
  try {
    const res = await getPlatformPool().query<{ system_prompt: string }>(
      `SELECT system_prompt FROM agent_templates
       WHERE status = 'published'
       ORDER BY version DESC
       LIMIT 1`
    )
    const prompt = res.rows[0]?.system_prompt
    if (prompt) {
      _promptCache = { prompt, expiresAt: Date.now() + PROMPT_CACHE_TTL_MS }
      return prompt
    }
  } catch (err) {
    console.warn('[mastra:platform] fetchPlatformPrompt DB error:', (err as Error).message)
  }
  const fallback = 'You are Disco, a helpful AI assistant.'
  _promptCache = { prompt: fallback, expiresAt: Date.now() + PROMPT_CACHE_TTL_MS }
  return fallback
}

// ---------------------------------------------------------------------------
// SERVER_TOOLS — real function-call implementations executed by Mastra.
// Named 'internet_search' (not 'web_search') to avoid Vertex AI reserved name
// conflict; 'web_search' as a functionDeclaration triggers native Search tool
// behavior which is incompatible with responseSchema/structured output.
// ---------------------------------------------------------------------------

// Lazy — avoids crash at module load when EXA_API_KEY is not set.
let _exa: ExaClass | null = null
function getExa(): ExaClass {
  if (!_exa) {
    if (!process.env.EXA_API_KEY) throw new Error('EXA_API_KEY is not configured')
    _exa = new ExaClass(process.env.EXA_API_KEY)
  }
  return _exa
}

export const SERVER_TOOLS = {
  internet_search: createTool({
    id: 'internet_search',
    description:
      'Search the internet for current information, news, facts, jobs, and real-time data.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
    }),
    execute: async (inputData) => {
      const { query } = inputData
      const { results } = await getExa().searchAndContents(query, {
        livecrawl: 'always',
        numResults: 5,
        text: { maxCharacters: 3000 },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return results.map((r: any) => ({
        title: r.title ?? null,
        url: r.url,
        content: (r.text ?? '').slice(0, 3000),
        publishedDate: r.publishedDate,
      }))
    },
  }),
  web_fetch: createTool({
    id: 'web_fetch',
    description: 'Fetch the content of a URL and return it as text.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch'),
    }),
    execute: async (inputData) => {
      const { url } = inputData
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        let response: Response
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Saarthi/1.0)' },
          })
        } finally {
          clearTimeout(timer)
        }
        if (!response.ok) {
          return { content: '', url, success: false as const, error: `HTTP ${response.status}` }
        }
        const raw = await response.text()
        const text = raw
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 5000)
        return { content: text, url, success: true as const }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: '', url, success: false as const, error: message }
      }
    },
  }),
}

// Server tool names used to filter out duplicate MCP tool registrations.
// 'web_search' is blocked because we expose it as 'internet_search' via Exa.
// 'create_plan_from_prd' is blocked because the agent must never call it —
// plan creation is user-triggered via the PlanCard "Create in System" button.
const SERVER_TOOL_NAMES = new Set([...Object.keys(SERVER_TOOLS), 'web_search', 'create_plan_from_prd'])

// MCP tool cache — avoids reconnecting to mcp-server on every message.
// TTL: 60 seconds per tenant.
const MCP_TOOLS_CACHE_TTL_MS = 5 * 60_000 // 5 minutes
const mcpToolsCache = new Map<string, { tools: Record<string, any>; expiresAt: number }>()

async function getCachedMcpTools(mcpClient: MCPClient, tenantId: string): Promise<Record<string, any>> {
  const cached = mcpToolsCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tools: Record<string, any> = {}
  try {
    tools = await mcpClient.listTools()
    mcpToolsCache.set(tenantId, { tools, expiresAt: Date.now() + MCP_TOOLS_CACHE_TTL_MS })
    console.log('[mastra] mcpToolsCache miss — fetched', Object.keys(tools).length, 'tools for tenant', tenantId)
  } catch (err) {
    console.warn('[mastra] listTools failed, continuing without MCP tools:', (err as Error).message)
  }
  return tools
}

// ---------------------------------------------------------------------------
// Guardrail processors — run on every message, input and output.
// strategy: 'warn' in demo/dev — logs violations but does not block.
// Switch to 'block' in production to hard-reject violating content.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProcessor = { onViolation?: (v: any) => void }

const violationHandler = createViolationHandler()

const promptInjectionDetector = new PromptInjectionDetector({
  model: liteModel,
  strategy: 'warn',
  threshold: 0.7,
  lastMessageOnly: true,
})
;(promptInjectionDetector as AnyProcessor).onViolation = violationHandler

const moderationProcessor = new ModerationProcessor({
  model: liteModel,
  strategy: 'warn',
  threshold: 0.5,
  lastMessageOnly: true,
})
;(moderationProcessor as AnyProcessor).onViolation = violationHandler

const piiDetector = new PIIDetector({
  model: liteModel,
  strategy: 'redact',
  redactionMethod: 'placeholder',
  lastMessageOnly: true,
})
;(piiDetector as AnyProcessor).onViolation = violationHandler

const systemPromptScrubber = new SystemPromptScrubber({
  model: liteModel,
})
;(systemPromptScrubber as AnyProcessor).onViolation = violationHandler

// ---------------------------------------------------------------------------
// One platform Agent — serves all tenants.
//
// instructions: dynamic — fetches latest published agentTemplate from DB.
// tools:        dynamic — builds per-request MCPClient from requestContext.
//               Falls back to SERVER_TOOLS when requestContext has no tenantId
//               (e.g., during tool discovery calls from Mastra Studio).
// memory:       getMastraMemory() singleton — isolation enforced by resourceId.
// model:        AI SDK connector routes through Inference Gateway at INFERENCE_GATEWAY_URL.
// ---------------------------------------------------------------------------

export const platformAgent = new Agent({
  id: 'disco',
  name: 'Disco',

  instructions: async ({ requestContext }: { requestContext?: RequestContext }) => {
    // Per-agent override takes precedence over the global agent_templates prompt.
    // Set by chatStream.ts from agentSkills.systemPrompt before calling stream().
    // PRD generation is handled by prdWorkflow (gatherStep → writeStep → formatStep).
    const override = requestContext?.get('agentSystemPrompt') as string | undefined
    return override ?? await fetchPlatformPrompt()
  },

  tools: async ({ requestContext }: { requestContext: RequestContext }) => {
    const tenantId = requestContext.get('tenantId') as string | undefined

    if (!tenantId) {
      // No tenant context — return SERVER_TOOLS only (Studio / health checks)
      return SERVER_TOOLS
    }

    // Reuse the pre-created MCPClient stored in requestContext by createTenantAgent().
    // This ensures one MCPClient per task execution — avoids creating a second client
    // alongside the one returned for disconnect in TenantAgentWithClient.
    const storedClient = requestContext.get('__mcpClient') as MCPClient | undefined
    const mcpClient = storedClient ?? getMCPClientForTenant(tenantId)

    const mcpTools = await getCachedMcpTools(mcpClient, tenantId)

    // Exclude MCP tools that duplicate SERVER_TOOLS.
    const filteredMcpTools = Object.fromEntries(
      Object.entries(mcpTools).filter(([key]) => {
        const blocked = Array.from(SERVER_TOOL_NAMES).some(
          (name) => key === name || key.endsWith(`_${name}`)
        )
        if (blocked) console.log(`[mastra] platformAgent filtering MCP tool: ${key}`)
        return !blocked
      })
    )

    return { ...filteredMcpTools, ...SERVER_TOOLS }
  },

  memory: getMastraMemory(),

  // Specialist agent delegation — Saarthi recognises pension scrutiny tasks
  // and routes them to AI-PARAS (Tier 2) which delegates reading to Tier 3.
  // agents: { aiParas: aiParasAgent },
  // NOTE: aiParasAgent removed from sub-agents map. Having it here caused
  // platformAgent's SERVER_TOOLS (internet_search, web_fetch) to leak into
  // aiParasAgent's tool list when called as a sub-agent. AI-PARAS is
  // registered standalone in the Mastra registry and testable directly in Studio.

  inputProcessors: [promptInjectionDetector, moderationProcessor],
  outputProcessors: [piiDetector, moderationProcessor, systemPromptScrubber],

  // Dynamic model selection:
  //   restricted data (CASA/KYC) → private model only (set by fetchAgentContext tool)
  //   thinkingBudget=0           → lite model (conversational turns)
  //   default                    → full model
  model: ({ requestContext }: { requestContext: RequestContext }) => {
    const sensitivity = requestContext?.get('maxDataSensitivity') as string | undefined
    if (sensitivity === 'restricted') return privateModel
    const budget = requestContext?.get('thinkingBudget') as number | undefined
    return budget === 0 ? liteModel : platformModel
  },
})

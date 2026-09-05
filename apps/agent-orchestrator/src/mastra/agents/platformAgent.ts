import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { ModerationProcessor, PIIDetector, PromptInjectionDetector, SystemPromptScrubber } from '@mastra/core/processors'
import { MCPClient } from '@mastra/mcp'
import { z } from 'zod'
import { Exa as ExaClass } from 'exa-js'
import pg from 'pg'

import { platformModel, liteModel, privateModel } from '../model.js'
import { selectModel } from './modelSelection.js'
import type { TenantContext } from '../context.js'
import { getMastraMemory } from '../memory.js'
import { getMCPClientForTenant } from '../tools.js'
import { isComposioEnabled, getComposioTools } from '../composio.js'
import { createViolationHandler } from '../guardrails.js'
import { makeAppPool } from '../../db.js'
import { retrieveDocumentsTool } from '../tools/retrieveDocuments.js'
import { listFolderTool } from '../tools/listFolder.js'
import { findInFolderTool } from '../tools/findInFolder.js'
import { readFileTool } from '../tools/readFile.js'
import { platformCapabilityTools } from '../tools/platform-capabilities.js'
import { askClarifyingQuestionsTool } from '../tools/askClarifyingQuestions.js'
import { renderCanvas } from '../tools/renderCanvas.js'
import { analyzeAudioTool } from '../tools/analyzeAudio.js'
import { analyzeVideoTool } from '../tools/analyzeVideo.js'
import { createSkillTool } from '../tools/createSkill.js'

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
  // RAG over the tenant's own uploaded corpus. Seeded prompts instruct agents to
  // "always call retrieve_documents"; without this registration that instruction
  // referred to a tool that did not exist and retrieval silently never ran.
  retrieve_documents: retrieveDocumentsTool,
  // start_task / get_task_thread — in-process calls into the shared
  // agent-platform MCP tool registry (no MCP protocol, no network hop). The
  // human/session caller carries no agentId, so Task 4's agent_tool_assignments
  // gate never applies here; access is checked purely on role permission.
  ...platformCapabilityTools,
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
  ask_clarifying_questions: askClarifyingQuestionsTool,
  render_canvas: renderCanvas,
  analyze_audio: analyzeAudioTool,
  analyze_video: analyzeVideoTool,
  // User-triggered only — the tool description tells the model never to call
  // this on its own initiative. See createSkill.ts for the confirm-gate and
  // tenantId/userId/agentId/conversationId provenance rules.
  create_skill: createSkillTool,
  // Folder scope: the agent is granted a handle to a folder, not its contents.
  // list_folder is the manifest — names and types only, no bytes read.
  list_folder: listFolderTool,
  // Routes to files, never answers — returns a ranked list so the agent spends
  // one read on the right file instead of pulling the folder into context.
  find_in_folder: findInFolderTool,
  // Reads one file, enforced against the grant before a byte is fetched.
  read_file: readFileTool,
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

  instructions: async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
    // Per-agent override takes precedence over the global agent_templates prompt.
    // Set by chatStream.ts from agentSkills.systemPrompt before calling stream().
    // PRD generation is handled by prdWorkflow (gatherStep → writeStep → formatStep).
    const override = requestContext?.get('agentSystemPrompt') as string | undefined
    const base = override ?? await fetchPlatformPrompt()
    // Persona personality is a layer composed ahead of the base prompt, never a
    // replacement for it — an agent with a persona keeps 100% of its normal
    // capabilities, just with a personality prepended. Set by chatStream.ts from
    // agentPersonas.basePersonality.
    const persona = requestContext?.get('personaPersonality') as string | undefined
    const composed = persona ? `${persona}\n\n${base}` : base
    // Hardcoded tool-usage contract — appended to every prompt path (DB template,
    // per-agent override, persona) so no variant can silently drop this rule.
    const CLARIFICATION_CONTRACT = `\n\n## Clarifying questions — required behaviour
ALWAYS call the ask_clarifying_questions tool whenever you need more information before proceeding. This applies to:
- The first time you need clarification on a request.
- Every subsequent round of follow-up questions, no matter how many rounds that takes.
NEVER write a clarifying question as plain prose, a bulleted list, or any other text in your reply. If you have a question, call the tool. If you write questions as text instead of calling the tool, the user cannot answer them interactively and the conversation will break.`
    const CODE_BLOCK_CONTRACT = `\n\n## Code formatting — required behaviour
ALWAYS specify the language identifier on every fenced code block. Examples: \`\`\`python, \`\`\`typescript, \`\`\`bash, \`\`\`sql, \`\`\`json, \`\`\`yaml.
NEVER write a fenced code block with no language tag (i.e. never use a bare \`\`\` with nothing after it). If you are genuinely unsure of the language, use \`\`\`text as a fallback.`
    const CANVAS_CONTRACT = `\n\n## Canvas output — required behaviour
Whenever your response contains structured or long-form content — analyses, comparisons, plans, summaries, reports, code explanations, tables, step-by-step guides, or anything exceeding roughly 200 words — you MUST call the render_canvas tool with the full markdown content BEFORE writing your reply in chat.
- Set title to a short, descriptive label (e.g. "Q3 Competitive Analysis", "Onboarding Plan").
- Set type to "document" unless the content is specifically a PRD ("prd"), roadmap ("roadmap"), or task list ("tasks").
- Your chat reply should then be a brief 1–3 sentence summary pointing the user to the canvas, NOT a repeat of the full content.
For short conversational answers or simple one-liners, do NOT call render_canvas.

After retrieve_documents returns content: you MUST call render_canvas with a structured summary or analysis of that content in the SAME response. Do not acknowledge the document and wait — produce the output immediately.

NEVER claim to have called render_canvas unless you actually called it in this response. If you did not call render_canvas, do not say "I sent it to the canvas", "I rendered a summary", or anything implying you did. If you realise you forgot to render something, call render_canvas now instead of defending a claim you cannot back up.`
    return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT
  },

  tools: async ({ requestContext }: { requestContext: RequestContext<TenantContext> }) => {
    const tenantId = requestContext.get('tenantId') as string | undefined

    if (!tenantId) {
      // No tenant context — return SERVER_TOOLS only (Studio / health checks)
      return SERVER_TOOLS
    }

    // --- Composio path (primary when COMPOSIO_ENABLED=true) ---
    if (isComposioEnabled()) {
      try {
        const composioTools = await getComposioTools(tenantId)

        // Filter out any Composio tools that conflict with SERVER_TOOLS.
        const filteredComposioTools = Object.fromEntries(
          Object.entries(composioTools).filter(([key]) => {
            const blocked = Array.from(SERVER_TOOL_NAMES).some(
              (name) => key === name || key.endsWith(`_${name}`)
            )
            if (blocked) console.log(`[mastra] platformAgent filtering Composio tool: ${key}`)
            return !blocked
          })
        )

        console.log(`[mastra] using Composio tools (${Object.keys(filteredComposioTools).length}) for tenant ${tenantId}`)
        return { ...filteredComposioTools, ...SERVER_TOOLS }
      } catch (err) {
        // Composio failed — fall through to MCP backup.
        console.warn('[mastra] Composio tool fetch failed, falling back to MCP:', (err as Error).message)
      }
    }

    // --- MCP path (backup / default when Composio is disabled or errored) ---
    const storedClient = requestContext.get('__mcpClient') as MCPClient | undefined
    const mcpClient = storedClient ?? getMCPClientForTenant(
      tenantId,
      requestContext.get('agentId') as string | undefined,
      requestContext.get('sessionId') as string | undefined,
    )

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

  // Dynamic model selection — see modelSelection.ts for the precedence order and
  // why it's a separate module (testability: this file eagerly builds DB/network
  // singletons like getMastraMemory() at import time).
  model: selectModel,
})

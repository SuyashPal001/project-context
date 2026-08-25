import { describe, it, expect, vi } from 'vitest'

/**
 * retrieve_documents was defined, tested, and never registered on an agent.
 *
 * Every seeded Research Engineer is instructed to "always call
 * retrieve_documents before responding", and chatStream watches for that tool
 * firing to mark a turn as RAG-backed — but the tool was absent from the
 * agent's toolset, so retrieval silently never ran. These tests pin the tool
 * into the registry so the instruction and the toolset cannot drift apart again.
 */

// platformAgent builds memory, models and guardrails at module load; none of
// that is under test here and all of it wants live infrastructure.
vi.mock('../../db.js', () => ({ makeAppPool: () => ({ on: vi.fn(), query: vi.fn() }) }))
vi.mock('../memory.js', () => ({ getMastraMemory: () => ({}) }))
vi.mock('../model.js', () => ({ platformModel: {}, liteModel: {}, privateModel: {} }))
vi.mock('../tools.js', () => ({ getMCPClientForTenant: vi.fn() }))
vi.mock('../composio.js', () => ({ isComposioEnabled: () => false, getComposioTools: vi.fn() }))
vi.mock('../guardrails.js', () => ({ createViolationHandler: () => vi.fn() }))
// Pulls in the Drizzle client, which reads DATABASE_URL at module load.
vi.mock('@serverless-saas/ai', () => ({ retrieveChunks: vi.fn() }))
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/mcp', () => ({ getMcpRegistry: vi.fn() }))
vi.mock('@serverless-saas/agent-capabilities', () => ({ registerAgentPlatformMcpTools: vi.fn() }))
vi.mock('@serverless-saas/permissions', () => {
  // See platform-capabilities.test.ts for why both a `default` key and the
  // named export are needed here.
  const resolveUserPermissions = vi.fn()
  return { default: { resolveUserPermissions }, resolveUserPermissions }
})

describe('SERVER_TOOLS', () => {
  it('registers the document retrieval tool the prompts instruct agents to call', async () => {
    const { SERVER_TOOLS } = await import('../agents/platformAgent.js')

    expect(Object.keys(SERVER_TOOLS)).toContain('retrieve_documents')
  })

  it('exposes retrieval alongside the web research tools', async () => {
    const { SERVER_TOOLS } = await import('../agents/platformAgent.js')

    // Exhaustive by design: every name here is something the model can be
    // asked to call, so widening the agent's reach should require editing this
    // list rather than happening as a side effect of adding a file.
    expect(Object.keys(SERVER_TOOLS).sort()).toEqual([
      'analyze_audio',
      'analyze_video',
      'ask_clarifying_questions',
      'find_in_folder',
      'get_task_thread',
      'internet_search',
      'list_folder',
      'render_canvas',
      'retrieve_documents',
      'start_task',
      'web_fetch',
    ])
  })
})

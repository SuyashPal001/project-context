/**
 * Test harness for the Mastra agent pipeline.
 *
 * Sets up requestContext exactly like chatStream.ts so agents behave
 * identically to production — no hallucinated tenantId, no missing tools.
 *
 * Usage:
 *   npx tsx scripts/testAgent.ts "I need a PRD for auth"
 *   npx tsx scripts/testAgent.ts --agent pm "write a PRD for auth"
 *   npx tsx scripts/testAgent.ts --agent platform "what tools do you have?"
 */

import 'dotenv/config'
import { randomUUID } from 'crypto'
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { pmAgent } from '../src/mastra/agents/pmAgent.js'
import { platformAgent } from '../src/mastra/index.js'
import { getMCPClientForTenant } from '../src/mastra/tools.js'
import { getThinkingBudget } from '../src/mastra/thinking.js'
import { fetchAgentSkill } from '../src/usage.js'
import { isPmIntent, fetchPrdDraft } from '../src/routes/pmRouting.js'

// ── Test identity (disco.suyash@gmail.com / Acme Corp) ────────────────────────
const TEST_TENANT_ID = '9a6d3bc0-9db7-47fc-83b1-3abc046e4ba5'
const TEST_AGENT_ID  = '588a1709-257a-42ec-8d2d-99c9ef3dc87f'  // PM Agent
const TEST_USER_ID   = '74f553bc-52e2-43aa-bc24-94f302aa1508'  // disco.suyash@gmail.com

async function main() {
  // Parse --agent flag: npx tsx testAgent.ts --agent pm "message"
  const args = process.argv.slice(2)
  let forceAgent: 'pm' | 'platform' | null = null
  let message: string | undefined

  if (args[0] === '--agent') {
    const val = args[1]
    if (val !== 'pm' && val !== 'platform') {
      console.error('--agent must be "pm" or "platform"')
      process.exit(1)
    }
    forceAgent = val
    message = args[2]
  } else {
    message = args[0]
  }

  if (!message) {
    console.error('Usage: npx tsx scripts/testAgent.ts [--agent pm|platform] "<message>"')
    process.exit(1)
  }

  const conversationId = randomUUID()
  const sessionId      = `test-${Date.now()}`

  console.log('\n─────────────────────────────────────────────')
  console.log(`tenant : ${TEST_TENANT_ID}`)
  console.log(`agent  : ${TEST_AGENT_ID}`)
  console.log(`user   : ${TEST_USER_ID}`)
  console.log(`convId : ${conversationId}`)
  console.log(`force  : ${forceAgent ?? 'auto (isPmIntent)'}`)
  console.log(`msg    : ${message}`)
  console.log('─────────────────────────────────────────────\n')

  // ── Build requestContext exactly like chatStream.ts ────────────────────────
  const requestContext = new RequestContext()
  requestContext.set(MASTRA_RESOURCE_ID_KEY, TEST_TENANT_ID)
  requestContext.set(MASTRA_THREAD_ID_KEY, conversationId)
  requestContext.set('tenantId', TEST_TENANT_ID)
  requestContext.set('agentId', TEST_AGENT_ID)
  requestContext.set('userId', TEST_USER_ID)

  const mcpClient = getMCPClientForTenant(TEST_TENANT_ID)
  requestContext.set('__mcpClient', mcpClient as any)

  const agentSkill = await fetchAgentSkill(TEST_AGENT_ID)
  if (agentSkill?.systemPrompt) {
    requestContext.set('agentSystemPrompt', agentSkill.systemPrompt)
  }

  const thinkingBudget = getThinkingBudget(message)
  requestContext.set('thinkingBudget', thinkingBudget)

  const sessionCtx = `<session_context>\ntenant_id: ${TEST_TENANT_ID}\n</session_context>\n\n`
  const fullMessage = sessionCtx + message

  // ── Route to pmAgent or platformAgent ─────────────────────────────────────
  let agentStream: any
  const usePm = forceAgent === 'pm' || (forceAgent === null && isPmIntent(message))

  if (usePm) {
    const draft = await fetchPrdDraft(TEST_AGENT_ID, TEST_TENANT_ID)
    if (draft) {
      requestContext.set('existingPrdDraft', draft.content)
      requestContext.set('existingPrdId', draft.id)
    }
    console.log(`[route] pmAgent (draft=${!!draft})`)
    agentStream = await pmAgent.stream(fullMessage, {
      resourceId: TEST_TENANT_ID,
      threadId: conversationId,
      requestContext,
    })
  } else {
    console.log('[route] platformAgent')
    agentStream = await (platformAgent as any).stream(fullMessage, {
      resourceId: TEST_TENANT_ID,
      threadId: conversationId,
      requestContext,
      providerOptions: { google: { thinkingConfig: { thinkingBudget } } },
    })
  }

  // ── Stream to terminal ─────────────────────────────────────────────────────
  process.stdout.write('\n[response]\n')

  for await (const chunk of agentStream.fullStream as AsyncIterable<any>) {
    // Text delta
    if (chunk.type === 'text-delta') {
      if (chunk.textDelta) process.stdout.write(chunk.textDelta)
      continue
    }

    // Tool call start
    if (chunk.type === 'tool-call') {
      process.stdout.write(`\n[tool:${chunk.toolName}] input: ${JSON.stringify(chunk.args)}\n`)
      continue
    }

    // Tool result
    if (chunk.type === 'tool-result') {
      const preview = JSON.stringify(chunk.result).slice(0, 200)
      process.stdout.write(`[tool:${chunk.toolName}] result: ${preview}${preview.length >= 200 ? '…' : ''}\n`)
      continue
    }

    // Finish
    if (chunk.type === 'finish') {
      process.stdout.write(`\n\n[done] stopReason=${chunk.finishReason} tokens=${JSON.stringify(chunk.usage ?? {})}\n`)
    } else if (!['text-delta', 'tool-call', 'tool-result'].includes(chunk.type)) {
      // Debug: show unknown chunk types
      process.stdout.write(`[chunk:${chunk.type}] ${JSON.stringify(chunk).slice(0, 150)}\n`)
    }
  }

  console.log('\n─────────────────────────────────────────────\n')
  process.exit(0)
}

main().catch(err => {
  console.error('[testAgent] fatal:', err)
  process.exit(1)
})

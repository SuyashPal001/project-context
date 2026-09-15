/**
 * End-to-end harness: platformAgent (Olmo) → agent-director delegate → generate_image.
 * Mirrors every requestContext key chatStream.ts sets in production, so the delegate
 * gate and processors behave the same as a real turn. Verifies:
 *   1. Olmo actually delegates to agent-director (isn't gated out).
 *   2. Director inside the delegate calls generate_image (not just narrative reply).
 *   3. The tool result contains a fileId (or a clear refusalReason if it failed).
 *
 * Usage:
 *   NODE_EXTRA_CA_CERTS=$(pwd)/supabase-ca.crt \
 *     npx tsx scripts/testDirector.ts "generate an image of a red apple"
 */
import 'dotenv/config'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { platformAgent } from '../src/mastra/index.js'
import { getMCPClientForTenant } from '../src/mastra/tools.js'
import { runWithGuardrailContext } from '../src/mastra/guardrails.js'

// Real "test-agent" tenant — exists in the tenants table so spend_credits
// won't FK-fail. Built-in Olmo agent + its actual owner user.
const TEST_TENANT_ID = 'bc4d0cde-bd88-4c58-bdb5-bd421628bccd'
const TEST_AGENT_ID  = '9d33551e-824e-469e-96ee-a3f257a91c72'
const TEST_USER_ID   = '708f9d64-bfa0-477a-9cb5-f4f238bbeba3'
// Grant all four delegates. In prod this comes from fetchAllowedSubAgents(); for
// the harness we skip the DB round-trip and pass them explicitly.
const ALLOWED_DELEGATES = ['agent-director', 'agent-pm', 'agent-architect', 'agent-producer']

export async function runDirectorHarness(defaultMessage?: string) {
  const message = process.argv.slice(2).join(' ') || defaultMessage || 'Delegate to the Director agent and generate a small image of a red apple on a white background.'
  const conversationId = randomUUID()
  const sessionId = `test-director-${Date.now()}`

  console.log(`\ntenant=${TEST_TENANT_ID} conv=${conversationId}`)
  console.log(`msg=${JSON.stringify(message)}\n`)

  const ctx = new RequestContext()
  // Mastra resource + thread — same as chatStream.ts.
  ctx.set(MASTRA_RESOURCE_ID_KEY, TEST_TENANT_ID)
  ctx.set(MASTRA_THREAD_ID_KEY, conversationId)
  // Tenant/user/session identity.
  ctx.set('tenantId', TEST_TENANT_ID)
  ctx.set('agentId', TEST_AGENT_ID)
  ctx.set('userId', TEST_USER_ID)
  ctx.set('sessionId', sessionId)
  ctx.set('conversationId', conversationId)
  // idToken normally comes from the Cognito session. Without it uploadGeneratedFile
  // will 401 and the tool will return { refused: true, refusalReason: 'STORAGE_FAILED' } —
  // that is still a *successful* proof that Director called generate_image, since the
  // refusal shape only lands after the gateway returned an image. Leave empty.
  ctx.set('idToken', '')
  // Agent identity: platformAgent uses agentName for its Identity contract and
  // isBuiltInAgent for the delegate host filter.
  ctx.set('agentName', 'Olmo')
  ctx.set('isBuiltInAgent', true)
  ctx.set('allowedSubAgents', ALLOWED_DELEGATES)
  ctx.set('thinkingBudget', 1024)

  const mcpClient = getMCPClientForTenant(TEST_TENANT_ID)
  ctx.set('__mcpClient', mcpClient as any)

  let sawDelegate = false
  let sawGenerateImage = false
  let fileId: string | undefined
  let refusalReason: string | undefined
  let delegateText: string | undefined
  let chunkTypes = new Set<string>()

  await runWithGuardrailContext({ tenantId: TEST_TENANT_ID, conversationId }, async () => {
    const stream = await (platformAgent as any).stream(message, {
      resourceId: TEST_TENANT_ID,
      threadId: conversationId,
      requestContext: ctx,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 1024 } } },
    })

    // AI SDK v6 fullStream shape: outer chunks carry `{type, payload:{toolName,...}}`
    // for supervisor tool-calls; the delegate's own inner chunks surface as
    // `tool-output` events whose `payload.output` is the delegate's original
    // chunk. Peek both to detect nested tool-calls (generate_image inside
    // agent-director) and tool-errors.
    for await (const chunk of stream.fullStream as AsyncIterable<any>) {
      chunkTypes.add(chunk.type)
      if (chunk.type === 'tool-call' && chunk.payload?.toolName) {
        const outerName = chunk.payload.toolName
        process.stdout.write(`\n▶ tool-call: ${outerName}\n`)
        if (outerName === 'agent-director' || outerName === 'agent_director') sawDelegate = true
      } else if (chunk.type === 'tool-output' && chunk.payload?.output) {
        const inner = chunk.payload.output
        if (inner.type === 'tool-call' && inner.payload?.toolName) {
          const innerName = inner.payload.toolName
          process.stdout.write(`  ▶ delegate internal tool-call: ${innerName}\n`)
          if (innerName === 'generate_image' || innerName === 'generate-image') {
            sawGenerateImage = true
            sawDelegate = true // generate_image can only run inside agent-director
          }
        } else if (inner.type === 'tool-result' && inner.payload) {
          const innerName = inner.payload.toolName
          const innerResult = inner.payload.result ?? inner.payload.output ?? {}
          process.stdout.write(`  ◀ delegate internal tool-result: ${innerName}  ${JSON.stringify(innerResult).slice(0, 300)}\n`)
          if (innerName === 'generate_image' || innerName === 'generate-image') {
            if (innerResult.fileId) fileId = innerResult.fileId
            if (innerResult.refusalReason) refusalReason = innerResult.refusalReason
          }
        } else if (inner.type === 'text-delta' && inner.payload?.text) {
          delegateText = (delegateText ?? '') + inner.payload.text
        } else if (inner.type === 'tool-error') {
          console.log(`  [delegate tool-error] ${(inner.payload?.error?.cause?.message ?? JSON.stringify(inner.payload?.error)).slice(0, 500)}`)
        }
      } else if (chunk.type === 'text-delta' && chunk.payload?.text) {
        process.stdout.write(chunk.payload.text)
      }
    }
  })

  console.log('\n\n─── VERDICT ─────────────────────────')
  console.log(`chunk types seen                : ${[...chunkTypes].join(', ') || '(none)'}`)
  console.log(`delegate agent-director called  : ${sawDelegate ? '✓' : '✗'}`)
  console.log(`generate_image called inside    : ${sawGenerateImage ? '✓' : '✗'}`)
  console.log(`fileId returned                 : ${fileId ?? '(none)'}`)
  console.log(`refusalReason (if any)          : ${refusalReason ?? '(none)'}`)
  if (delegateText) console.log(`delegate text (first 200)       : ${delegateText.slice(0, 200)}`)
  console.log('─────────────────────────────────────\n')

  // Verdict
  if (sawDelegate && sawGenerateImage && (fileId || refusalReason === 'STORAGE_FAILED')) {
    console.log('✅ PASS — Olmo delegated, Director called generate_image, tool executed to completion.')
    if (refusalReason === 'STORAGE_FAILED') console.log('  (STORAGE_FAILED is expected here — no idToken → upload 401. The gateway did return an image.)')
    process.exit(0)
  }
  if (sawDelegate && !sawGenerateImage) {
    console.log('❌ FAIL — Director was called but did NOT invoke generate_image (narrative-only reply). Guardrails should have blocked this.')
    process.exit(1)
  }
  if (!sawDelegate) {
    console.log('❌ FAIL — Olmo never delegated to Director. Check delegate gating (allowedSubAgents, isBuiltInAgent, host filter).')
    process.exit(1)
  }
  console.log('⚠️  INCONCLUSIVE — delegate + tool call happened but no fileId and no refusalReason. Inspect above.')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDirectorHarness().catch(err => { console.error('\n[testDirector] fatal:', err); process.exit(1) })
}

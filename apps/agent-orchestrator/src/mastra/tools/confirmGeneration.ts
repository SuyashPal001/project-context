import { randomUUID } from 'node:crypto'
import { isUnlimited, resolveRate } from '@serverless-saas/credits'
import { saveGenerationConfirmRequest, updateGenerationConfirmRequest } from '../../persistence.js'
import { pendingGenerationConfirmations, sessionActiveGenerationConfirmations } from '../../types.js'

const CONFIRM_TIMEOUT_MS = 300_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function confirmGenerationOrDecline(
  execContext: any,
  resourceType: string,
  subject: string,
  label: string,
): Promise<{ confirmed: boolean }> {
  const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
  const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
  const userId = execContext?.requestContext?.get('userId') as string | undefined
  const sendEvent = execContext?.requestContext?.get('sendEvent') as
    ((event: string, data: object) => void) | undefined
  const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
  const idToken = execContext?.requestContext?.get('idToken') as string | undefined

  // No active session — mirrors askClarifyingQuestionsTool's own guard.
  // Not reachable today (Director/Producer only run via chatStream.ts's
  // live-session path); included so this doesn't hang or throw the day
  // these tools become reachable from a non-SSE context.
  if (!sendEvent || !sessionId || !tenantId || !userId) {
    return { confirmed: true }
  }

  if (await isUnlimited(tenantId)) {
    return { confirmed: true }
  }

  const rate = await resolveRate(resourceType, subject)
  if (!rate) {
    return { confirmed: true }
  }

  // At most one pending confirm per session — a second concurrent request
  // declines immediately rather than queuing. MessageThread.tsx's overlay
  // only ever considers the last message, so a second simultaneous card
  // would have no UI to render into; see spec §5.
  const existing = sessionActiveGenerationConfirmations.get(sessionId)
  if (existing && existing.size > 0) {
    return { confirmed: false }
  }

  const confirmationId = randomUUID()
  const confirmMessageId = randomUUID()
  sendEvent('generation_confirm_request', { confirmationId, resourceType, subject, label })

  if (conversationId && idToken) {
    saveGenerationConfirmRequest(idToken, conversationId, confirmMessageId, {
      id: confirmationId, resourceType, subject, label, status: 'pending',
    })
  }

  let sessionSet = sessionActiveGenerationConfirmations.get(sessionId)
  if (!sessionSet) {
    sessionSet = new Set()
    sessionActiveGenerationConfirmations.set(sessionId, sessionSet)
  }
  sessionSet.add(confirmationId)

  const confirmed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingGenerationConfirmations.get(confirmationId)
      pendingGenerationConfirmations.delete(confirmationId)
      sessionActiveGenerationConfirmations.get(sessionId)?.delete(confirmationId)
      resolve(false)

      if (pending?.messageId && pending?.conversationId && pending?.idToken) {
        updateGenerationConfirmRequest(pending.idToken, pending.conversationId, pending.messageId, {
          status: 'declined',
          decisionAt: new Date().toISOString(),
        })
      }
    }, CONFIRM_TIMEOUT_MS)
    pendingGenerationConfirmations.set(confirmationId, {
      resolve, timer, tenantId,
      messageId: confirmMessageId,
      conversationId,
      idToken,
    })
  })

  return { confirmed }
}

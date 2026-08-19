import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { pendingClarifications } from '../../types.js'
import { saveClarificationRequest } from '../../persistence.js'

const CLARIFICATION_TIMEOUT_MS = 120_000

// Lets the platform agent pause mid-conversation to ask 1+ multiple-choice
// clarifying questions instead of generating output on an ambiguous request.
// Mirrors the MCP write-tool approval gate (sessions.ts /mcp/approval-request)
// but generalized from a single yes/no decision to N structured answers.
export const askClarifyingQuestionsTool = createTool({
  id: 'ask_clarifying_questions',
  description:
    'Pause and ask the user one or more multiple-choice clarifying questions before proceeding ' +
    'with an ambiguous or underspecified request. Use this instead of guessing when the user\'s ' +
    'intent could reasonably resolve to more than one distinct output.',
  inputSchema: z.object({
    questions: z.array(z.object({
      prompt: z.string().describe('The question to ask'),
      options: z.array(z.object({
        label: z.string(),
        rationale: z.string().optional(),
      })).min(1),
      allowFreeText: z.boolean().optional().default(true),
      allowSkip: z.boolean().optional().default(true),
    })).min(1),
  }),
  execute: async (inputData, execContext) => {
    const sendEvent = execContext?.requestContext?.get('sendEvent') as
      ((event: string, data: object) => void) | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const userId = execContext?.requestContext?.get('userId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined

    if (!sendEvent || !sessionId || !tenantId || !userId) {
      return { answers: [], error: 'no_active_session' }
    }

    const clarificationId = crypto.randomUUID()
    const clarificationMessageId = crypto.randomUUID()
    sendEvent('clarification_request', { clarificationId, questions: inputData.questions })

    if (conversationId && idToken) {
      saveClarificationRequest(idToken, conversationId, clarificationMessageId, {
        id: clarificationId,
        questions: inputData.questions,
        status: 'pending',
      })
    }

    const answers = await new Promise<Array<{ questionIndex: number; selectedIndex?: number; freeText?: string; skipped?: boolean }>>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout still returns whatever the user had already answered before
        // going idle, rather than discarding partial progress as a full blank.
        const pending = pendingClarifications.get(clarificationId)
        pendingClarifications.delete(clarificationId)
        resolve(pending?.collected ?? [])
      }, CLARIFICATION_TIMEOUT_MS)
      pendingClarifications.set(clarificationId, {
        resolve,
        timer,
        expectedCount: inputData.questions.length,
        collected: [],
        tenantId,
        userId,
        messageId: clarificationMessageId,
        conversationId,
        idToken,
      })
    })

    return {
      answers: answers.map((a, i) => ({
        prompt: inputData.questions[a.questionIndex]?.prompt ?? `question ${i}`,
        selectedLabel: a.selectedIndex !== undefined
          ? inputData.questions[a.questionIndex]?.options[a.selectedIndex]?.label
          : undefined,
        freeText: a.freeText,
        skipped: a.skipped ?? false,
      })),
    }
  },
})

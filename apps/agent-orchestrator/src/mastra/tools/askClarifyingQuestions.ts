import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { latestIdToken } from '../../freshIdToken.js'
import { pendingClarifications, sessionActiveClarification } from '../../types.js'
import { saveClarificationRequest, updateClarificationRequest } from '../../persistence.js'
import { clarificationAnswerText, type TurnPauseFn, type TurnResumeFn } from '../../routes/turnAnswer.js'

// Long enough to compare four generated faces or think about a brief. The SSE
// heartbeat keeps the stream open while this tool waits, and a client
// disconnect resolves the wait early (routes/chat.ts), so a long timeout never
// strands the agent. A late answer after this fires is re-sent by the web
// client as a normal chat message.
const CLARIFICATION_TIMEOUT_MS = 30 * 60_000

// Lets the platform agent pause mid-conversation to ask 1+ multiple-choice
// clarifying questions instead of generating output on an ambiguous request.
// Mirrors the MCP write-tool approval gate (sessions.ts /mcp/approval-request)
// but generalized from a single yes/no decision to N structured answers.
export const askClarifyingQuestionsTool = createTool({
  id: 'ask_clarifying_questions',
  description:
    'Pause and ask the user one or more multiple-choice clarifying questions before proceeding ' +
    'with an ambiguous or underspecified request. Use this instead of guessing when the user\'s ' +
    'intent could reasonably resolve to more than one distinct output. ' +
    'Set multiSelect on a question when the user must pick several options together (e.g. ' +
    '"select exactly 3 partner logos") — without it, the UI only lets them pick one option.',
  inputSchema: z.object({
    questions: z.array(z.object({
      prompt: z.string().describe('The question to ask'),
      options: z.array(z.object({
        label: z.string(),
        rationale: z.string().optional(),
        imageFileId: z.string().uuid().optional().describe('fileId of an image this option stands for (e.g. a generated variation); the card shows it as a thumbnail'),
        voiceId: z.string().optional().describe('voice id (list_casting_assets kind "voice") this option stands for; the card shows a play button so the user can hear it'),
        voiceLanguage: z.string().optional().describe('language code the voice preview plays in (e.g. "hi"); defaults to English'),
      })).min(0).optional().default([]),
      allowFreeText: z.boolean().optional().default(true),
      allowSkip: z.boolean().optional().default(true),
      multiSelect: z.object({
        min: z.number().int().min(1).describe('Minimum options the user must select'),
        max: z.number().int().min(1).describe('Maximum options the user may select'),
      }).optional().describe('Set this when the question needs several options picked together, not one — e.g. min:3, max:3 for "select exactly 3".'),
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

    if (sessionId) sessionActiveClarification.set(sessionId, clarificationId)
    // The question ends this part of the turn; the answer starts the next (chatStream.ts).
    ;(execContext?.requestContext?.get('pauseTurn' as never) as TurnPauseFn | undefined)?.()

    const answers = await new Promise<Array<{ questionIndex: number; selectedIndex?: number; selectedIndices?: number[]; freeText?: string; skipped?: boolean; files?: { fileId: string; name: string; type: string }[] }>>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout still returns whatever the user had already answered before
        // going idle, rather than discarding partial progress as a full blank.
        const pending = pendingClarifications.get(clarificationId)
        pendingClarifications.delete(clarificationId)
        const collected = pending?.collected ?? []
        // Nobody answered: a turn whose page is gone ends quietly (chatStream.ts).
        ;(execContext?.requestContext?.get('endIfDetached' as never) as (() => void) | undefined)?.()
        resolve(collected)

        // Flip the DB row out of 'pending' so the message never becomes a
        // permanently invisible orphan once the agent produces a later message.
        if (pending?.messageId && pending?.conversationId && pending?.idToken) {
          const allSkipped = collected.length === 0 || collected.every((a) => a.skipped === true)
          const answersMap: Record<number, { selectedIndex?: number; selectedIndices?: number[]; freeText?: string; skipped?: boolean; files?: { fileId: string; name: string; type: string }[] }> = {}
          for (const a of collected) {
            answersMap[a.questionIndex] = { selectedIndex: a.selectedIndex, selectedIndices: a.selectedIndices, freeText: a.freeText, skipped: a.skipped, files: a.files }
          }
          updateClarificationRequest(pending.idToken, pending.conversationId, pending.messageId, {
            status: allSkipped ? 'skipped' : 'answered',
            answers: Object.keys(answersMap).length > 0 ? answersMap : undefined,
            answeredAt: new Date().toISOString(),
          })
        }
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

    if (sessionId) sessionActiveClarification.delete(sessionId)
    const answerFiles = answers.flatMap((a) => a.files ?? [])
    ;(execContext?.requestContext?.get('resumeTurn' as never) as TurnResumeFn | undefined)?.(clarificationAnswerText(inputData.questions, answers), answerFiles)
    // The user just answered, so the browser handed over a fresh id token
    // (freshIdToken.ts) — later calls in this turn, tools included, use it.
    if (conversationId && idToken) execContext?.requestContext?.set('idToken', latestIdToken(conversationId, idToken))

    return {
      answers: answers.map((a, i) => ({
        prompt: inputData.questions[a.questionIndex]?.prompt ?? `question ${i}`,
        selectedLabel: a.selectedIndex !== undefined
          ? inputData.questions[a.questionIndex]?.options[a.selectedIndex]?.label
          : undefined,
        selectedLabels: a.selectedIndices?.map((idx) => inputData.questions[a.questionIndex]?.options[idx]?.label).filter((l): l is string => !!l),
        files: a.files,
        freeText: a.freeText,
        skipped: a.skipped ?? false,
      })),
    }
  },
})

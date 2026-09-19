import { createScorer, extractTrajectory } from '@mastra/core/evals'

type MessagePart = { type: string; text?: string }
type MastraDBMessageLike = { role: string; content: MessagePart[] }
type ClarificationGroundTruth = { requiresClarification?: boolean }

// Rule from CLARIFICATION_CONTRACT (platformAgent.ts): any clarifying
// question must go through ask_clarifying_questions — never as plain
// prose in the chat reply. Items where groundTruth.requiresClarification
// is true additionally require the tool to have actually fired — silently
// guessing instead of asking is the regression this scorer exists to catch.
const CLARIFICATION_TOOL_NAME = 'ask_clarifying_questions'

export function hasStrayQuestion(messages: MastraDBMessageLike[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.some((part) => part.type === 'text' && part.text?.includes('?')),
  )
}

export const clarificationToolUsageScorer = createScorer({
  id: 'clarification-tool-usage',
  name: 'Clarification tool usage',
  description: 'Clarifying questions must use ask_clarifying_questions, never plain-text prose',
  type: 'agent',
}).generateScore(({ run }) => {
  const output = run.output as unknown as MastraDBMessageLike[]
  if (hasStrayQuestion(output)) return 0

  const requiresClarification = Boolean((run.groundTruth as ClarificationGroundTruth | undefined)?.requiresClarification)
  if (!requiresClarification) return 1

  const trajectory = extractTrajectory(run.output as any)
  const calledTool = trajectory.steps.some(
    (step) => step.stepType === 'tool_call' && step.name === CLARIFICATION_TOOL_NAME,
  )
  return calledTool ? 1 : 0
})

import { createScorer, extractTrajectory } from '@mastra/core/evals'

type MessagePart = { type: string; text?: string }
type MastraDBMessageLike = { role: string; content: MessagePart[] }

// Rule from CANVAS_CONTRACT (platformAgent.ts): long-form output must call
// render_canvas before the chat reply, and the chat reply itself must stay
// short (a pointer to the canvas, not a restatement of the content).
const CANVAS_TOOL_NAME = 'render_canvas'
const MAX_REPLY_WORDS = 60

export function assistantWordCount(messages: MastraDBMessageLike[]): number {
  let count = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'text' || !part.text) continue
      count += part.text.trim().split(/\s+/).filter(Boolean).length
    }
  }
  return count
}

export const canvasComplianceScorer = createScorer({
  id: 'canvas-compliance',
  name: 'Canvas compliance',
  description: 'Long-form replies must call render_canvas before a short chat reply',
  type: 'agent',
}).generateScore(({ run }) => {
  const output = run.output as unknown as MastraDBMessageLike[]
  const trajectory = extractTrajectory(run.output as any)
  const calledCanvas = trajectory.steps.some(
    (step) => step.stepType === 'tool_call' && step.name === CANVAS_TOOL_NAME,
  )
  if (!calledCanvas) return 0
  return assistantWordCount(output) <= MAX_REPLY_WORDS ? 1 : 0
})

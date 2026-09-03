import type { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../context.js'
import { platformModel, liteModel, privateModel, resolveModel } from '../model.js'

// Dynamic model selection, in precedence order:
//   1. restricted data (CASA/KYC) → private model only — non-negotiable, checked first
//   2. a user-selected model (via the chat UI's model picker, set by chatStream.ts
//      onto requestContext as 'selectedModel') → resolved on demand
//   3. thinkingBudget=0 → lite model (conversational turns)
//   4. default → full model
//
// Typed with a required `requestContext` to match platformAgent.ts's original inline
// function (and Mastra's DynamicArgument signature) — but still reached defensively
// via `?.` below, since the original code did too despite the non-optional type.
export function selectModel({ requestContext }: { requestContext: RequestContext<TenantContext> }) {
  const sensitivity = requestContext?.get('maxDataSensitivity') as string | undefined
  if (sensitivity === 'restricted') return privateModel

  const selectedModel = requestContext?.get('selectedModel') as string | undefined
  if (selectedModel) return resolveModel(selectedModel)

  const budget = requestContext?.get('thinkingBudget') as number | undefined
  return budget === 0 ? liteModel : platformModel
}

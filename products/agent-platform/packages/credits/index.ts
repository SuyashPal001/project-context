/**
 * Task credit logic shared by the agent orchestrator and the API Lambda.
 *
 * These pieces live here, rather than in the orchestrator where the rest of
 * the credit code sits, because the watchdog needs them and runs in the API
 * Lambda — and neither package can import the other. They cannot live in
 * `packages/foundation/*` either: task charge keys and retry attempts are
 * agent-platform concepts, not anything a second SaaS product would share.
 *
 * settleTask, chargeTaskEstimate and debitChatTurn deliberately stay in
 * apps/agent-orchestrator/src/credits.ts. Nothing else calls them, and moving
 * live money code with no second consumer buys risk for nothing.
 */
export { taskChargeKey, attemptFromChargeKey } from './chargeKey'
export { refundTask, bumpCreditAttempt, shortestExpiresAt } from './refund'
export type { CreditPool, RefundTaskArgs, RefundTaskDeps } from './refund'

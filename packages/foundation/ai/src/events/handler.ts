/**
 * Event Handler for Agent Runtime
 *
 * Accumulates streaming events from the runtime and forwards them to the frontend.
 * DB writes (saving messages, usage records) are intentionally left to the caller
 * so the AI package stays decoupled from the exact schema and transaction logic.
 */

import type { AgentEventHandler } from '../runtime/interface';
import type { AgentEvent, UsageReport } from '../runtime/types';

export interface EventHandlerContext {
  tenantId: string;
  userId: string;
  conversationId: string;
  /**
   * Called for every event received from the runtime.
   * Typically wraps pushToConnectedClients() from @serverless-saas/cache.
   * Errors are swallowed so push failures don't abort the relay.
   */
  pushToFrontend?: (event: AgentEvent) => Promise<void>;
}

export interface EventHandlerResult {
  /** Full assistant response — either from agent.message or accumulated agent.message.delta chunks */
  accumulatedContent: string;
  /** Usage report from usage.report or session.ended events */
  usage?: UsageReport;
  /** Error messages from 'error' events */
  errors: string[];
}

/**
 * Create a stateful event handler for a single relay call.
 *
 * @returns handler — pass to runtime.startSession() and runtime.sendMessage()
 * @returns getResult — call after sendMessage completes to read accumulated state
 */
export function createEventHandler(context: EventHandlerContext): {
  handler: AgentEventHandler;
  getResult: () => EventHandlerResult;
} {
  let accumulatedContent = '';
  let usage: UsageReport | undefined;
  const errors: string[] = [];
  let consecutivePushFailures = 0;
  const MAX_PUSH_FAILURES = 3;

  const handler: AgentEventHandler = async (event: AgentEvent) => {
    // Forward every event to the frontend (best-effort — failures are non-fatal)
    // ORCHESTRATOR: circuit breaker — stop pushing after 3 consecutive failures to
    // avoid log spam and wasted network calls for a broken WS connection.
    if (context.pushToFrontend && consecutivePushFailures < MAX_PUSH_FAILURES) {
      try {
        await context.pushToFrontend(event);
        consecutivePushFailures = 0;
      } catch (err) {
        consecutivePushFailures++;
        if (consecutivePushFailures >= MAX_PUSH_FAILURES) {
          console.warn('[EventHandler] Too many push failures — disabling WS push for this session');
        } else {
          console.warn('[EventHandler] pushToFrontend failed, continuing:', err);
        }
      }
    }

    // Accumulate state for events the relay cares about
    switch (event.type) {
      case 'agent.message':
        // Full message delivered — overwrite any accumulated deltas
        accumulatedContent = event.content;
        break;

      case 'agent.message.delta':
        accumulatedContent += event.delta;
        break;

      case 'usage.report':
        usage = event.usage;
        break;

      case 'session.ended':
        if (event.usage) usage = event.usage;
        break;

      case 'error':
        errors.push(event.message);
        console.error('[EventHandler] Runtime error event:', event.code, event.message);
        break;

      default:
        // agent.thinking, tool.calling, tool.result, canvas.update, approval.required,
        // session.started — forwarded to frontend above, no additional state to track
        break;
    }
  };

  return {
    handler,
    getResult: (): EventHandlerResult => ({ accumulatedContent, usage, errors }),
  };
}

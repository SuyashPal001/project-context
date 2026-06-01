// Abstract interfaces for agent runtimes

import type {
  AgentRunRequest,
  AgentRunResponse,
  AgentSessionConfig,
  AgentEvent,
  SendMessageResult,
  SessionResult,
  UsageReport,
} from './types';

// =============================================================================
// STATELESS INTERFACE — used by VertexAdapter (direct LLM calls)
// =============================================================================

export interface AgentRuntime {
  /**
   * Run agent with given messages and config.
   * Returns the assistant's response.
   */
  run(request: AgentRunRequest): Promise<AgentRunResponse>;

  /**
   * Stream agent response (for real-time chat).
   * Yields partial responses as they come.
   */
  streamRun?(request: AgentRunRequest): AsyncIterable<Partial<AgentRunResponse>>;

  /**
   * Check if runtime is available/configured.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get runtime identifier.
   */
  getName(): string;
}

// =============================================================================
// SESSION-BASED INTERFACE — implement this to wire an agent runtime adapter
//
// All runtime adapters implement this interface. The message relay route calls this
// without knowing what's underneath.
// =============================================================================

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

/**
 * Connection config for a VM runtime (not per-session — just how to reach the VM).
 */
export interface RuntimeConfig {
  /** WebSocket endpoint for VM */
  wsEndpoint?: string;
  /** HTTP endpoint for VM (fallback or health checks) */
  httpEndpoint?: string;
  /** Auth token for VM connection */
  authToken?: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Session-based runtime interface for VM adapters.
 *
 * Lifecycle: startSession → sendMessage (N times) → endSession
 * Approvals: submitApproval when ApprovalRequiredEvent is received
 */
export interface AgentSessionRuntime {
  /** Runtime identifier */
  readonly name: string;

  /**
   * Start a new agent session with full configuration.
   *
   * Sends skill, policy, LLM credentials, and conversation history to the VM.
   * Events stream back via onEvent callback for the lifetime of the session.
   *
   * @param config - Full session bundle (tenant, agent, skill, policy, LLM)
   * @param onEvent - Callback invoked for each event from the VM
   */
  startSession(
    config: AgentSessionConfig,
    onEvent: AgentEventHandler,
  ): Promise<SessionResult>;

  /**
   * Send a user message within an existing session.
   *
   * @param sessionId - Active session ID (from startSession)
   * @param message - User message content
   * @param onEvent - Callback for streaming events (agent.message.delta, tool.calling, etc.)
   */
  sendMessage(
    sessionId: string,
    message: string,
    onEvent: AgentEventHandler,
  ): Promise<SendMessageResult>;

  /**
   * End a session gracefully.
   *
   * @param sessionId - Session to close
   * @param reason - Why the session is ending
   * @returns Final usage report, or null if unavailable
   */
  endSession(
    sessionId: string,
    reason: 'completed' | 'user_cancelled' | 'timeout',
  ): Promise<UsageReport | null>;

  /**
   * Submit a human approval decision for a pending action.
   *
   * Called after receiving an ApprovalRequiredEvent.
   *
   * @param sessionId - Session with the pending approval
   * @param approvalId - ID from ApprovalRequiredEvent
   * @param approved - Whether to allow the action
   * @param feedback - Optional message sent to the agent
   */
  submitApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    feedback?: string,
  ): Promise<void>;

  /**
   * Check if the VM runtime is reachable.
   */
  healthCheck(): Promise<boolean>;
}

/**
 * Factory function type for creating session runtime instances.
 */
export type AgentSessionRuntimeFactory = (config: RuntimeConfig) => AgentSessionRuntime;

/**
 * Runtime Factory
 *
 * Returns the appropriate AgentSessionRuntime adapter based on configuration.
 * No adapter is currently wired — implement one and register it here.
 */

import type { AgentSessionRuntime } from './interface';

export type RuntimeType = 'mastra';

export function getRuntime(_type: RuntimeType = 'mastra'): AgentSessionRuntime {
  throw new Error(
    '[getRuntime] No agent runtime configured. ' +
    'Implement an AgentSessionRuntime adapter and register it in factory.ts.',
  );
}

export function selectRuntime(_tenantId: string): RuntimeType {
  return 'mastra';
}

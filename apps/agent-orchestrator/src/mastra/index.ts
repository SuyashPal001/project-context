// Mastra proper orchestrator — ADR: Mastra Proper Orchestrator Adoption
//
// One Mastra instance registered at startup.
// One platform-level Agent (olmo) serving all tenants.
// Per-tenant isolation via RequestContext + MASTRA_RESOURCE_ID_KEY.
//
// Backward-compat re-exports let app.ts and workflow.ts import unchanged.

import { Mastra } from '@mastra/core/mastra'
import { MastraEditor } from '@mastra/editor'
import { Observability, DefaultExporter } from '@mastra/observability'

import { getMastraStore, getMastraMemory } from './memory.js'
import { BACKGROUND_TASKS } from './backgroundTasks.js'
import { ingestionWorkflow } from './workflows/ingestionWorkflow.js'

import { platformAgent, SERVER_TOOLS } from './agents/platformAgent.js'
import { formatterAgent } from './agents/formatterAgent.js'
import { directorAgent } from './agents/directorAgent.js'
import { producerAgent } from './agents/producerAgent.js'

import { skillDraftWorkflow } from './workflows/skillDraftWorkflow.js'

// ---------------------------------------------------------------------------
// Mastra instance — registered at startup with storage and platformAgent.
// Enables Mastra Studio, OTel spans, evals, and prompt versioning.
// ---------------------------------------------------------------------------

export const mastra = new Mastra({
  agents: {
    olmo: platformAgent,
    formatter: formatterAgent,
    director: directorAgent,
    producer: producerAgent,
  },
  workflows: {
    documentIngestion: ingestionWorkflow,
    'skill-draft': skillDraftWorkflow,
  },
  storage: getMastraStore(),
  scheduler: {
    enabled: true,
    tickIntervalMs: 30_000, // check every 30s
  },
  backgroundTasks: BACKGROUND_TASKS,
  editor: new MastraEditor(),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'project-context-agent-orchestrator',
        exporters: [new DefaultExporter()],
      },
    },
  }),
})

// ---------------------------------------------------------------------------
// Re-exports — all consumers import from this file unchanged.
// ---------------------------------------------------------------------------

export { platformModel } from './model.js'
export { platformAgent, SERVER_TOOLS }
export { formatterAgent }
export { getMastraStore, getMastraMemory } from './memory.js'
export { getMCPClientForTenant, getToolsForTenant } from './tools.js'
export { createTenantAgent } from './agent.js'
export type { TenantAgentWithClient } from './agent.js'

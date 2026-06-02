import { Workspace, LocalFilesystem } from '@mastra/core/workspace'
import { fileURLToPath } from 'url'
import path from 'path'

// ---------------------------------------------------------------------------
// PRD Workspace — filesystem rooted at apps/agent-orchestrator/skills/.
// Uses import.meta.url so the path is resolved relative to this file,
// not process.cwd() — safe regardless of how pm2/node launches the process.
// This file lives at dist/mastra/workspace/prdWorkspace.js at runtime,
// so ../../../skills resolves to apps/agent-orchestrator/skills/.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// prdWorkspace.ts is at dist/mastra/workspace/ — relay root is three levels up
const relayRoot = path.resolve(__dirname, '../../../')

export const prdWorkspace = new Workspace({
  id: 'prd-workspace',
  name: 'PRD Workspace',
  filesystem: new LocalFilesystem({ basePath: relayRoot }),
  skills: ['skills'], // Mastra discovers prd-writing/ and requirements-gathering/ inside skills/
})

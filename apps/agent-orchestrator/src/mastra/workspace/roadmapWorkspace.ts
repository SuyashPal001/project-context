import { Workspace, LocalFilesystem } from '@mastra/core/workspace'
import { fileURLToPath } from 'url'
import path from 'path'

// ---------------------------------------------------------------------------
// Roadmap Workspace — filesystem rooted at apps/agent-orchestrator/skills/roadmap-planning/.
// Uses import.meta.url so the path is resolved relative to this file,
// not process.cwd() — safe regardless of how pm2/node launches the process.
// This file lives at dist/mastra/workspace/roadmapWorkspace.js at runtime,
// so ../../../skills/roadmap-planning resolves correctly.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// roadmapWorkspace.ts is at dist/mastra/workspace/ — relay root is three levels up
const relayRoot = path.resolve(__dirname, '../../../')

export const roadmapWorkspace = new Workspace({
  id: 'roadmap-workspace',
  name: 'Roadmap Workspace',
  filesystem: new LocalFilesystem({ basePath: relayRoot }),
  skills: ['skills/roadmap-planning'],
})

import { Workspace, LocalFilesystem } from '@mastra/core/workspace'
import { fileURLToPath } from 'url'
import path from 'path'

// ---------------------------------------------------------------------------
// Task Workspace — filesystem rooted at apps/agent-orchestrator/skills/task-breakdown/.
// Uses import.meta.url so the path is resolved relative to this file,
// not process.cwd() — safe regardless of how pm2/node launches the process.
// This file lives at dist/mastra/workspace/taskWorkspace.js at runtime,
// so ../../../skills/task-breakdown resolves correctly.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// taskWorkspace.ts is at dist/mastra/workspace/ — relay root is three levels up
const relayRoot = path.resolve(__dirname, '../../../')

export const taskWorkspace = new Workspace({
  id: 'task-workspace',
  name: 'Task Workspace',
  filesystem: new LocalFilesystem({ basePath: relayRoot }),
  skills: ['skills/task-breakdown'],
})

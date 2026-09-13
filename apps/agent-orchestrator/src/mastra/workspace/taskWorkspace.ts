import { Workspace, LocalFilesystem } from '@mastra/core/workspace'
import { fileURLToPath } from 'url'
import path from 'path'

// ---------------------------------------------------------------------------
// Task Workspace — filesystem rooted at
// apps/agent-orchestrator/skills/task-breakdown/, and ONLY that directory.
// basePath used to be the whole app root (relayRoot), which put .env,
// node_modules, dist, and package.json inside a Workspace every tenant's
// Saarthi Task run shares (this Workspace is one module-level singleton,
// attached to one global taskAgent — not per-tenant). Narrowed to this
// skill's own folder with `contained: true` (default) so nothing outside it
// is even reachable, and `readOnly: true` since this Workspace only ever
// needs to serve its shipped SKILL.md, never write back into it.
//
// Uses import.meta.url so the path is resolved relative to this file, not
// process.cwd() — safe regardless of how pm2/node launches the process. This
// file lives at dist/mastra/workspace/taskWorkspace.js at runtime, so
// ../../../skills/task-breakdown resolves correctly.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// taskWorkspace.ts is at dist/mastra/workspace/ — skills/task-breakdown is
// three levels up
const skillRoot = path.resolve(__dirname, '../../../skills/task-breakdown')

export const taskWorkspace = new Workspace({
  id: 'task-workspace',
  name: 'Task Workspace',
  filesystem: new LocalFilesystem({ basePath: skillRoot, readOnly: true }),
  skills: ['SKILL.md'],
})

import { Workspace, LocalFilesystem } from '@mastra/core/workspace'
import { fileURLToPath } from 'url'
import path from 'path'

// ---------------------------------------------------------------------------
// PRD Workspace — filesystem rooted at apps/agent-orchestrator/skills/, and
// ONLY that directory. basePath used to be the whole app root (relayRoot),
// which put .env, node_modules, dist, and package.json inside a Workspace
// every tenant's Saarthi PRD run shares (this Workspace is one module-level
// singleton, attached to one global prdAgent — not per-tenant). Narrowed to
// skillsRoot with `contained: true` (default) so nothing outside it is even
// reachable, and `readOnly: true` since this Workspace only ever needs to
// serve shipped skill instructions, never write back into them.
//
// Uses import.meta.url so the path is resolved relative to this file, not
// process.cwd() — safe regardless of how pm2/node launches the process. This
// file lives at dist/mastra/workspace/prdWorkspace.js at runtime, so
// ../../../skills resolves to apps/agent-orchestrator/skills/.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// prdWorkspace.ts is at dist/mastra/workspace/ — skills/ is three levels up
const skillsRoot = path.resolve(__dirname, '../../../skills')

export const prdWorkspace = new Workspace({
  id: 'prd-workspace',
  name: 'PRD Workspace',
  filesystem: new LocalFilesystem({ basePath: skillsRoot, readOnly: true }),
  // Finds every SKILL.md under skills/ — prd-writing/, requirements-gathering/,
  // and whatever else lives there — same discovery scope as before, just
  // rooted at skills/ instead of the app root.
  skills: ['./**/SKILL.md'],
})

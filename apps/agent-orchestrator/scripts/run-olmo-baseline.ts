// apps/agent-orchestrator/scripts/run-olmo-baseline.ts
import { mastra } from '../src/mastra/index.js'

const { datasets } = await mastra.datasets.list({})
const dataset = datasets.find((d) => d.name === 'olmo-contract-regression')
if (!dataset) throw new Error('Run seed-olmo-eval-dataset.ts --create first')

const summary = await mastra.datasets
  .get({ id: dataset.id })
  .then((d) =>
    d.startExperiment({
      name: `baseline-pre-prompt-block-migration-${new Date().toISOString()}`,
      targetType: 'agent',
      targetId: 'olmo',
      // No `scorers` field — resolution falls through to each item's own
      // `scorerIds` (set in Task 5), per Mastra's documented precedence:
      // experiment scorers > item scorerIds > dataset scorerIds > none.
    }),
  )

console.log('experimentId:', summary.experimentId ?? summary.id)
console.log('status:', summary.status)
console.log('succeeded:', summary.succeededCount, 'failed:', summary.failedCount)
process.exit(0)

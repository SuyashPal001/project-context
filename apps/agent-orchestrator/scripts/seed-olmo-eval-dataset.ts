// apps/agent-orchestrator/scripts/seed-olmo-eval-dataset.ts
// Usage:
//   pnpm tsx scripts/seed-olmo-eval-dataset.ts --list
//   pnpm tsx scripts/seed-olmo-eval-dataset.ts --create curated-items.json
import { mastra } from '../src/mastra/index.js'
import { getMastraStore } from '../src/mastra/memory.js'
import { readFileSync } from 'node:fs'

// Heuristic keyword buckets — these are starting points for human review,
// not a scoring rule. Every candidate gets read and confirmed by a human
// before it becomes a dataset item (see spec's sourcing rule).
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  identity: ['what model', 'who made you', 'who built you', 'what are you', 'are you chatgpt', 'are you gemini'],
  longform: ['comparison', 'analysis', 'roadmap', 'step-by-step', 'compare', 'summarize'],
  ambiguous: ['help me with', 'can you do', 'i need'],
}

// Maps each dataset category to the one scorer that applies to it (see
// spec's "Dataset" section — scorer precedence is experiment scorers >
// item scorerIds > dataset scorerIds > none, so tagging per item here and
// leaving startExperiment's own `scorers` field unset is what keeps each
// item scored only on its own behavior).
const CATEGORY_TO_SCORER_ID: Record<string, string> = {
  identity: 'no-provider-disclosure',
  longform: 'canvas-compliance',
  ambiguous: 'clarification-tool-usage',
}

async function listCandidates() {
  const store = getMastraStore()
  // store.db is the documented public accessor on PostgresStoreVNext/PostgresStore
  // (pg-promise style — .any/.one), confirmed against @mastra/pg@1.22.3's
  // dist/storage/index.d.ts:76-84. mastra_messages lives in the `mastra`
  // Postgres schema per memory.ts:74-84. Columns are camelCase (confirmed
  // against @mastra/core's TABLE_MESSAGES schema) — quote createdAt/resourceId.
  const rows = await store.db.any(
    `select id, "threadId", content, "createdAt"
     from mastra.mastra_messages
     where role = 'user'
     order by "createdAt" desc
     limit 500`,
  )
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    console.log(`\n=== ${category} (scorerId: ${CATEGORY_TO_SCORER_ID[category]}) ===`)
    const matches = rows.filter((row: any) => {
      const text = JSON.stringify(row.content).toLowerCase()
      return keywords.some((kw) => text.includes(kw))
    })
    for (const row of matches.slice(0, 15)) {
      console.log(`[${row.id}] ${JSON.stringify(row.content).slice(0, 200)}`)
    }
  }
}

async function createFromCurated(path: string) {
  const items: Array<{ category: string; input: string }> = JSON.parse(readFileSync(path, 'utf-8'))

  const validCategories = Object.keys(CATEGORY_TO_SCORER_ID)
  items.forEach((item, index) => {
    if (!validCategories.includes(item.category)) {
      throw new Error(
        `Item ${index} has unknown category "${item.category}" — expected one of: ${validCategories.join(', ')}`,
      )
    }
    if (typeof item.input !== 'string' || item.input.trim().length === 0) {
      throw new Error(`Item ${index} (category "${item.category}") has an empty or non-string input`)
    }
  })

  // Idempotency guard: this is a human-curated, review-then-commit workflow —
  // running --create twice must fail loudly rather than silently duplicating
  // the dataset (run-olmo-baseline.ts's .find() would then pick an arbitrary
  // one of the duplicates).
  const { datasets } = await mastra.datasets.list({})
  if (datasets.some((d) => d.name === 'olmo-contract-regression')) {
    throw new Error(
      'A dataset named "olmo-contract-regression" already exists. Delete it first via Studio, ' +
        'or choose a different name, before re-running --create. This script never adds to or ' +
        'overwrites an existing dataset.',
    )
  }

  const dataset = await mastra.datasets.create({ name: 'olmo-contract-regression' })
  await dataset.addItems({
    items: items.map((item) => ({
      input: item.input,
      metadata: { category: item.category },
      scorerIds: [CATEGORY_TO_SCORER_ID[item.category]],
      groundTruth: item.category === 'ambiguous' ? { requiresClarification: true } : undefined,
    })),
  })
  console.log(`Created dataset ${dataset.id} with ${items.length} items`)
}

const mode = process.argv[2]
if (mode === '--list') {
  await listCandidates()
} else if (mode === '--create') {
  const path = process.argv[3]
  if (!path) throw new Error('Usage: --create <curated-items.json>')
  await createFromCurated(path)
} else {
  console.log('Usage: --list | --create <curated-items.json>')
}
process.exit(0)

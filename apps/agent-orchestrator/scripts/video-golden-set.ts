// Golden set for the video breakdown (spec §8a). Run before shipping any prompt
// or model change: GOLDEN_DIR=<folder with fan_reel.mp4 + sony.mp4> pnpm tsx scripts/video-golden-set.ts
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runEvals } from '@mastra/core/evals'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { goldenCutsScorer, goldenHiddenCutsScorer, goldenMomentsScorer, goldenLegsScorer, missingFixtures, itemsWithTruth, resolveFixtures } from '../src/mastra/scorers/video/goldenScorers.js'

type Item = { input: { filePath: string }; groundTruth?: Record<string, unknown> }

async function main() {
  const dir = process.env.GOLDEN_DIR
  if (!dir) { console.error('Set GOLDEN_DIR to the folder holding fan_reel.mp4 and sony.mp4'); process.exit(1) }
  const data: Item[] = resolveFixtures(readFileSync(join(import.meta.dirname, 'video-golden-set.fixtures.json'), 'utf8'), dir)
  const missing = missingFixtures(data)
  if (missing.length) { console.error(`Missing fixture videos: ${missing.join(', ')}`); process.exit(1) }
  // Imported only after the checks above: the pipeline pulls in DB/env-heavy modules,
  // and a missing fixture must be reported, never hidden behind an import crash.
  const { breakDownLocalFile } = await import('../src/mastra/tools/videoBreakdown/breakDownVideo.js')
  // One paid breakdown per video, shared by every eval run below.
  const cache = new Map<string, ReturnType<typeof breakDownLocalFile>>()
  const step = createStep({ id: 'break-down-local-cached', inputSchema: z.object({ filePath: z.string() }), outputSchema: z.any(), execute: async ({ inputData }) => {
    if (!cache.has(inputData.filePath)) cache.set(inputData.filePath, breakDownLocalFile(inputData.filePath))
    return cache.get(inputData.filePath)!
  } })
  const target = createWorkflow({ id: 'video-breakdown-golden', inputSchema: z.object({ filePath: z.string() }), outputSchema: z.any() }).then(step).commit()

  const gates = await runEvals({ data, target, gates: [goldenHiddenCutsScorer, goldenCutsScorer] })
  // A video with no truth for a scorer must not count as a perfect score for it.
  const thresholds = []
  for (const [scorer, key] of [[goldenMomentsScorer, 'moments'], [goldenLegsScorer, 'legSides']] as const) {
    const subset = itemsWithTruth(data, key)
    if (subset.length) thresholds.push(await runEvals({ data: subset, target, scorers: [{ scorer, threshold: 0.75 }] }))
  }
  const runs = [gates, ...thresholds]
  const verdict = runs.some((r) => r.verdict === 'failed') ? 'failed' : runs.some((r) => r.verdict === 'scored') ? 'scored' : 'passed'
  console.log(JSON.stringify({ verdict, gates: { verdict: gates.verdict, scores: gates.scores, results: (gates as { gateResults?: unknown }).gateResults }, scores: Object.assign({}, ...thresholds.map((r) => r.scores)) }, null, 2))
  process.exit(verdict === 'passed' ? 0 : 1)
}
void main()

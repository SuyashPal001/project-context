/**
 * UGC avatar creator benchmark — grades the prompts Director writes for the
 * UGC avatar creator skill, without generating a single image.
 *
 * - Runs in its OWN process with its own small Mastra instance (Director only,
 *   no scheduler), so the live orchestrator on :3001 is never touched. Results
 *   land in the same Mastra storage, so they show up in Studio under
 *   Datasets › ugc-avatar-creator-prompts, where runs can be compared.
 * - Every generation and other paid tool is a Mastra tool mock: Director writes
 *   its prompts for real (real skill, real variety roll), but the image call
 *   returns a fake fileId. No images, no credits, no image quota.
 * - Director reads the skill from the database, so this tests the version that
 *   is SEEDED, not the file in the repo. Seed first, then run.
 *
 * Usage (on the VM, from apps/agent-orchestrator):
 *   npx tsx scripts/ugc-avatar-benchmark.ts
 */
import 'dotenv/config'
import { Mastra } from '@mastra/core'
import { directorAgentDelegate } from '../src/mastra/agents/directorAgent.js'
import { getMastraStore } from '../src/mastra/memory.js'
import { getPool } from '../src/usage.js'
import {
  createAvatarPromptContractScorer,
  lookTemplateFrom,
  type AvatarPromptExpectation,
} from '../src/mastra/scorers/avatarPromptContract.js'

const DATASET_NAME = 'ugc-avatar-creator-prompts'
const TARGET_ID = 'pc-director-delegate'

// Tools that spend money or write to a tenant's Drive. Each gets mocks so a
// run can never reach a vendor, even when Director calls it more than once.
const FAKE_IMAGE = { fileId: 'benchmark-image', name: 'benchmark.png', fileType: 'image/png', size: 1, model: 'mock' }
const PAID_TOOLS: Record<string, unknown> = {
  generate_images: {
    results: [0, 1, 2, 3].map((index) => ({ ...FAKE_IMAGE, index, fileId: `benchmark-image-${index + 1}` })),
    succeeded: 4,
    failed: 0,
  },
  generate_image: FAKE_IMAGE,
  edit_image: FAKE_IMAGE,
  crop_image: FAKE_IMAGE,
  save_as_avatar: { saved: false, error: 'benchmark run — nothing is saved' },
  generate_video: { refused: true, refusalReason: 'BENCHMARK' },
  generate_videos: { results: [], succeeded: 0, failed: 0 },
  generate_narration: { refused: true, refusalReason: 'BENCHMARK' },
  generate_song: { refused: true, refusalReason: 'BENCHMARK' },
  lipsync: { refused: true, refusalReason: 'BENCHMARK' },
}
const MOCKS_PER_TOOL = 3
const toolMocks = Object.entries(PAID_TOOLS).flatMap(([toolName, output]) =>
  Array.from({ length: MOCKS_PER_TOOL }, () => ({ toolName, args: {}, output, matchArgs: 'ignore' as const })),
)

interface Brief {
  key: string
  message: string
  expected: AvatarPromptExpectation
}

// Written the way Olmo delegates (see ugc-avatar-creator.md): look, gender,
// age range, framing, 3:4, count, and the "style: realistic avatar" marker.
const BRIEFS: Brief[] = [
  {
    key: 'indian-skincare-woman',
    message: 'Create 4 presenter avatar portrait variations.\nFor: skincare & beauty UGC video ads.\nWho: Indian woman, 22 to 30.\nVibe: relatable peer.\nframing: chest-up\nAspect ratio: 3:4.\nCount: 4.\nstyle: realistic avatar',
    expected: { count: 4, gender: 'woman' },
  },
  {
    key: 'indian-fitness-man-full-body',
    message: 'Create 4 presenter avatar portrait variations.\nFor: fitness app UGC video ads.\nWho: Indian man, 25 to 35.\nVibe: energetic coach.\nframing: full body\nAspect ratio: 3:4.\nCount: 4.\nstyle: realistic avatar',
    expected: { count: 4, gender: 'man', framing: 'full body' },
  },
  {
    key: 'mixed-looks-any-gender',
    message: 'Create 4 presenter avatar portrait variations.\nFor: a meal-kit brand\'s UGC video ads.\nWho: a mix of 4 different looks, any gender, 22 to 45.\nVibe: warm and chatty.\nframing: chest-up\nAspect ratio: 3:4.\nCount: 4.\nstyle: realistic avatar',
    expected: { count: 4 },
  },
  {
    key: 'older-woman-haircare',
    message: 'Create 4 presenter avatar portrait variations.\nFor: hair-wellness UGC video ads.\nWho: Indian woman, 40 to 50.\nVibe: calm, trusted educator.\nframing: chest-up\nAspect ratio: 3:4.\nCount: 4.\nstyle: realistic avatar',
    expected: { count: 4, gender: 'woman' },
  },
  {
    key: 'single-described-woman',
    message: 'Create a new presenter avatar portrait.\nFor: skincare & beauty UGC video ads.\nWho: Indian woman in her late 20s with natural dark open hair, wearing a smart casual top.\nVibe: relatable peer.\nSetting: modern airy living room.\nframing: chest-up\nAspect ratio: 3:4.\ncount: 1\nstyle: realistic avatar',
    expected: { count: 1, gender: 'woman' },
  },
  {
    key: 'image-to-avatar-same-person',
    message: 'Create 4 avatar variations from the user\'s reference photo.\nReference image fileId: benchmark-reference-photo\nIntent: same person, restyled.\nFor: skincare & beauty UGC video ads.\nWho: the woman in the photo, 25 to 32.\nframing: chest-up\nAspect ratio: 3:4.\nCount: 4.\nstyle: realistic avatar',
    expected: { count: 4, gender: 'woman', referenceFileId: 'benchmark-reference-photo' },
  },
]

async function seededSkill(): Promise<{ version: number; director: string }> {
  const res = await getPool().query<{ latest_version: number; director: string | null }>(
    `SELECT s.latest_version, sv.manifest->'references'->>'director.md' AS director
     FROM skills s JOIN skill_versions sv ON sv.skill_id = s.id AND sv.version = s.latest_version
     WHERE s.owner_tenant_id IS NULL AND s.is_official = true AND s.slug IN ('ugc-avatar-creator', 'avatar-creator')
     ORDER BY (s.slug = 'ugc-avatar-creator') DESC LIMIT 1`,
  )
  const row = res.rows[0]
  if (!row?.director) throw new Error('UGC avatar creator skill is not seeded — run db:seed:official-skills first')
  return { version: row.latest_version, director: row.director }
}

async function main() {
  const skill = await seededSkill()
  const scorer = createAvatarPromptContractScorer(lookTemplateFrom(skill.director))

  // Director alone — no Olmo, no scheduler, no background tasks. The memory-less
  // delegate variant, so runs never write working memory or recall each other.
  const mastra = new Mastra({
    agents: { [TARGET_ID]: directorAgentDelegate },
    scorers: { avatarPromptContract: scorer },
    storage: getMastraStore(),
  })

  const existing = (await mastra.datasets.list({})).datasets.find((d) => d.name === DATASET_NAME)
  const dataset = existing
    ? await mastra.datasets.get({ id: existing.id })
    : await mastra.datasets.create({
        name: DATASET_NAME,
        description: 'Briefs written the way Olmo delegates UGC avatar creation to Director. Image tools are mocked; the scorer grades the prompts.',
      })

  // Add any brief the dataset doesn't have yet. externalId keeps this idempotent;
  // change a brief by giving it a new key, never by editing one in place.
  const listed = await dataset.listItems({})
  const items = (Array.isArray(listed) ? listed : listed.items) as Array<{ externalId?: string | null }>
  const have = new Set(items.map((i) => i.externalId))
  const missing = BRIEFS.filter((b) => !have.has(b.key))
  if (missing.length > 0) {
    await dataset.addItems({
      items: missing.map((b) => ({
        externalId: b.key,
        input: b.message,
        groundTruth: b.expected,
        toolMocks,
        metadata: { brief: b.key },
      })),
    })
    console.log(`added ${missing.length} brief(s): ${missing.map((b) => b.key).join(', ')}`)
  }

  const summary = await dataset.startExperiment({
    name: `ugc-avatar-creator v${skill.version} — ${new Date().toISOString().slice(0, 16)}`,
    description: `Director prompts for the seeded UGC avatar creator skill v${skill.version}`,
    metadata: { skillVersion: skill.version },
    targetType: 'agent',
    targetId: TARGET_ID,
    scorers: [scorer],
    // Run as Olmo's delegation does: thinking on, so the full model is used.
    requestContext: { thinkingBudget: 1024 },
    maxConcurrency: 2,
    itemTimeout: 180_000,
  })

  console.log(`\nexperiment ${summary.experimentId} — ${summary.status}, ${summary.succeededCount}/${summary.totalItems} ran`)
  for (const result of summary.results) {
    const brief = String(result.metadata?.brief ?? result.itemId)
    const score = result.scores.find((s) => s.scorerId === 'avatar-prompt-contract')
    const shown = score?.score != null ? score.score.toFixed(2) : 'error'
    console.log(`${brief.padEnd(32)} ${shown}  ${score?.reason ?? score?.error ?? result.error?.message ?? ''}`)
  }
  console.log('\nOpen Studio › Datasets › ugc-avatar-creator-prompts to compare runs.')
  await getPool().end()
  process.exit(0)
}

main().catch((err) => {
  console.error('[ugc-avatar-benchmark] failed:', err)
  process.exit(1)
})

import { createScorer, extractTrajectory } from '@mastra/core/evals'

// Checks the prompts Director writes for the UGC avatar creator skill against
// that skill's own rules (official-skills/ugc-avatar-creator/director.md).
// Built for the ugc-avatar-creator benchmark (scripts/ugc-avatar-benchmark.ts),
// where image generation is mocked: this grades the prompt text, never the
// pixels. The Look line is taken from the skill text the run actually used,
// so a later wording change doesn't need an edit here.

export interface AvatarPromptExpectation {
  /** How many portraits the brief asks for (4 unless the brief says otherwise). */
  count?: number
  /** 'woman' or 'man' when the brief fixes it; the Look line's matching half must be used. */
  gender?: 'woman' | 'man'
  /** 'full body' when the brief asks for head-to-toe framing. */
  framing?: 'full body'
  /** A reference photo's fileId every item must carry, for image-to-avatar briefs. */
  referenceFileId?: string
}

export interface AvatarPromptCall {
  toolName: string
  args: Record<string, unknown>
}

export interface AvatarPromptCheck {
  name: string
  pass: boolean
  detail?: string
}

const GENERATION_TOOLS = new Set(['generate_images', 'generate_image'])

const LABELS = [
  'Use case',
  'Asset type',
  'Primary request',
  'Scene/backdrop',
  'Subject',
  'Look',
  'Wardrobe',
  'Style/medium',
  'Composition/framing',
  'Lighting/mood',
  'Constraints',
  'Avoid',
]

// Words director.md bans from skin descriptions; the image model renders them
// as an oily face. "shiny" is left out on purpose: the skill's own lines use it
// negatively ("never shiny", "oily, shiny or blotchy skin" in Avoid).
const GLOW_WORDS = /\b(glow|glows|glowing|dewy|luminous|radiant)\b/i
const PORES = /\b(visible|natural) pores\b/i

/** The `Look:` template line from the skill's director.md text, or undefined. */
export function lookTemplateFrom(directorText: string): string | undefined {
  const line = directorText.split('\n').find((l) => l.trim().startsWith('Look:'))
  return line?.trim().slice('Look:'.length).trim()
}

/**
 * The fixed phrases of the Look template that every prompt must carry word for
 * word: the template minus its <pretty/handsome> slot and its woman/man halves,
 * split into clauses.
 */
export function lookFragments(template: string): { shared: string[]; woman?: string; man?: string } {
  // The <pretty for a woman, handsome for a man> slot goes first, or the
  // halves below would match inside it.
  const body = template.replace(/<[^>]*>/g, '|')
  const woman = body.match(/for a woman ([^;]+);/)?.[1]?.trim()
  const man = body.match(/for a man ([^;]+);/)?.[1]?.trim()
  const shared = body
    .replace(/for a woman [^;]+;/, '|')
    .replace(/for a man [^;]+;/, '|')
    .split(/[|;]| — |\(|\)/)
    .flatMap((part) => part.split(/,\s+/))
    .map((part) => part.trim().replace(/^and /, ''))
    .filter((part) => part.length >= 12)
  return { shared, woman, man }
}

function promptLine(prompt: string, label: string): string {
  const line = prompt.split('\n').find((l) => l.trim().startsWith(`${label}:`))
  return line?.trim().slice(label.length + 1).trim() ?? ''
}

/** Each portrait item from Director's generation calls, flattened. */
export function portraitItems(calls: AvatarPromptCall[]): Array<Record<string, unknown>> {
  return calls.flatMap((call) => {
    if (call.toolName === 'generate_images') {
      const items = call.args.items
      return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []
    }
    return [call.args]
  })
}

/** Every rule check for one run, given Director's tool calls in order. */
export function checkAvatarPrompts(
  toolCalls: AvatarPromptCall[],
  lookTemplate: string | undefined,
  expected: AvatarPromptExpectation = {},
): AvatarPromptCheck[] {
  const checks: AvatarPromptCheck[] = []
  const names = toolCalls.map((c) => c.toolName)
  const firstGeneration = names.findIndex((n) => GENERATION_TOOLS.has(n))
  const generationCalls = toolCalls.filter((c) => GENERATION_TOOLS.has(c.toolName))
  const items = portraitItems(generationCalls)
  const prompts = items.map((item) => String(item.prompt ?? ''))
  const count = expected.count ?? 4

  checks.push({ name: 'loads the skill first', pass: names[0] === 'skill', detail: names[0] })
  checks.push({
    name: 'rolls variations before generating',
    pass: names.includes('roll_avatar_variations') && (firstGeneration === -1 || names.indexOf('roll_avatar_variations') < firstGeneration),
  })
  checks.push({
    name: `asks for ${count} portrait${count === 1 ? '' : 's'} in one call`,
    pass: generationCalls.length === 1 && items.length === count,
    detail: `${generationCalls.length} call(s), ${items.length} item(s)`,
  })
  if (items.length === 0) return checks

  checks.push({ name: 'every portrait is 3:4', pass: items.every((i) => i.aspectRatio === '3:4') })

  const missingLabels = LABELS.filter((label) => prompts.some((p) => !promptLine(p, label)))
  checks.push({ name: 'every labeled line is present', pass: missingLabels.length === 0, detail: missingLabels.join(', ') || undefined })

  if (lookTemplate) {
    const { shared, woman, man } = lookFragments(lookTemplate)
    const missing = shared.filter((fragment) => prompts.some((p) => !promptLine(p, 'Look').includes(fragment)))
    checks.push({ name: 'Look line copied word for word', pass: missing.length === 0, detail: missing.slice(0, 3).join(' | ') || undefined })
    if (expected.gender) {
      const want = expected.gender === 'woman' ? woman : man
      const other = expected.gender === 'woman' ? man : woman
      const word = expected.gender === 'woman' ? 'pretty' : 'handsome'
      checks.push({
        name: `Look line uses the ${expected.gender} half`,
        pass: prompts.every((p) => {
          const look = promptLine(p, 'Look')
          return look.startsWith(word) && (!want || look.includes(want)) && (!other || !look.includes(other))
        }),
      })
    }
  } else {
    checks.push({ name: 'Look line copied word for word', pass: false, detail: 'skill has no Look line' })
  }

  const glow = prompts.find((p) => GLOW_WORDS.test(p.split('\n').filter((l) => !l.trim().startsWith('Avoid:')).join('\n')))
  checks.push({ name: 'no glow, dewy, luminous or radiant skin words', pass: !glow, detail: glow ? glow.match(GLOW_WORDS)?.[0] : undefined })
  checks.push({ name: 'never writes visible or natural pores', pass: !prompts.some((p) => PORES.test(p)) })
  checks.push({
    name: 'Avoid line bans repeated rings',
    pass: prompts.every((p) => /identical rings/i.test(promptLine(p, 'Avoid'))),
  })

  if (count > 1) {
    const subjects = new Set(prompts.map((p) => promptLine(p, 'Subject')))
    checks.push({ name: 'each portrait is a different person', pass: subjects.size === prompts.length })
  }
  if (expected.framing === 'full body') {
    checks.push({
      name: 'full-body framing',
      pass: prompts.every((p) => /head to toe/i.test(promptLine(p, 'Composition/framing'))),
    })
  }
  if (expected.referenceFileId) {
    checks.push({
      name: 'every portrait uses the reference photo',
      pass: items.every((i) => Array.isArray(i.referenceFileIds) && (i.referenceFileIds as unknown[]).includes(expected.referenceFileId)),
    })
  }
  return checks
}

/** Director's tool calls, in order, from an agent run's output messages. */
export function toolCallsFromOutput(output: unknown): AvatarPromptCall[] {
  const trajectory = extractTrajectory(output as never)
  return trajectory.steps
    .filter((step) => step.stepType === 'tool_call')
    .map((step) => ({ toolName: step.name, args: ((step as { toolArgs?: Record<string, unknown> }).toolArgs ?? {}) }))
}

/**
 * Scores one run 0–1: the share of checks that passed. The reason lists the
 * failed checks. `lookTemplate` is the Look line of the skill version under test.
 */
export function createAvatarPromptContractScorer(lookTemplate: string | undefined) {
  const run = (output: unknown, groundTruth: unknown) =>
    checkAvatarPrompts(toolCallsFromOutput(output), lookTemplate, (groundTruth ?? {}) as AvatarPromptExpectation)

  return createScorer({
    id: 'avatar-prompt-contract',
    name: 'UGC avatar prompt contract',
    description: "Director's avatar prompts follow the UGC avatar creator skill: skill loaded, variety roll, labeled lines, Look line word for word, no glow words, one-ring rule",
    type: 'agent',
  })
    .generateScore(({ run: r }) => {
      const checks = run(r.output, r.groundTruth)
      return checks.length === 0 ? 0 : checks.filter((c) => c.pass).length / checks.length
    })
    .generateReason(({ run: r }) => {
      const failed = run(r.output, r.groundTruth).filter((c) => !c.pass)
      if (failed.length === 0) return 'All checks passed.'
      return `Failed: ${failed.map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name)).join('; ')}`
    })
}

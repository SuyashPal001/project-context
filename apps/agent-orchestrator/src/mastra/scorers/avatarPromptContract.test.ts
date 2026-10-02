import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAvatarPrompts, lookFragments, lookTemplateFrom, type AvatarPromptCall } from './avatarPromptContract.js'

const DIRECTOR_MD = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../products/agent-platform/packages/api/seeds/official-skills/ugc-avatar-creator/director.md',
  ),
  'utf8',
)
const LOOK = lookTemplateFrom(DIRECTOR_MD)!

// The Look line the way the skill wants it written for a woman: "pretty"
// chosen, the man half dropped.
const womanLook = LOOK.replace(/<[^>]*>/, 'pretty').replace(/ for a man [^;]+;/, '')

function prompt(overrides: Record<string, string> = {}): string {
  const lines: Record<string, string> = {
    'Use case': 'photorealistic-natural',
    'Asset type': 'reusable AI presenter avatar for skincare & beauty UGC video ads',
    'Primary request': 'a believable phone-video frame of a relatable Indian woman creator talking directly to camera',
    'Scene/backdrop': 'a modern airy living room, softly blurred',
    Subject: 'an exact age of 28; long angular face; wheatish medium-brown skin with a fresh soft-matte finish',
    Look: womanLook,
    Wardrobe: 'a beige linen top; no visible brands; at most one simple ring and small earrings',
    'Style/medium': 'photorealistic candid smartphone front-camera video still',
    'Composition/framing': "vertical 3:4; chest-up at eye level; arm's-length phone viewpoint",
    'Lighting/mood': 'soft window daylight from one side, gentle falloff on the far cheek',
    Constraints: 'one person only; no beauty filter (light natural makeup is fine)',
    Avoid: 'posed stock headshot; oily, shiny or blotchy skin; identical rings or jewellery repeated on several fingers',
    ...overrides,
  }
  return Object.entries(lines).map(([label, text]) => `${label}: ${text}`).join('\n')
}

function run(items: Array<Record<string, unknown>>): AvatarPromptCall[] {
  return [
    { toolName: 'skill', args: { name: 'ugc-avatar-creator' } },
    { toolName: 'roll_avatar_variations', args: { look: 'Indian', count: items.length } },
    { toolName: 'generate_images', args: { items } },
  ]
}

const failed = (calls: AvatarPromptCall[], expected = {}) =>
  checkAvatarPrompts(calls, LOOK, expected).filter((c) => !c.pass).map((c) => c.name)

describe('avatar prompt contract scorer', () => {
  it('reads the Look line and its woman and man halves from the skill', () => {
    const { shared, woman, man } = lookFragments(LOOK)
    expect(shared).toContain('matte, velvety skin with zero shine'.split(', ')[1])
    expect(shared.some((f) => f.includes('photogenic enough to be a popular social-media creator'))).toBe(true)
    expect(woman).toMatch(/mascara/)
    expect(man).toMatch(/beard/)
  })

  it('passes four different people written the way the skill asks', () => {
    const items = [28, 31, 25, 35].map((age) => ({
      prompt: prompt({ Subject: `an exact age of ${age}; soft-matte skin` }),
      aspectRatio: '3:4',
    }))
    expect(failed(run(items), { count: 4, gender: 'woman' })).toEqual([])
  })

  it('catches the v17 slip: shortened Look, glowing skin, flat light', () => {
    const v17 = prompt({
      Subject: '25-year-old Indian woman; golden-brown skin with a subtle glowing complexion; camera-ready, attractive face',
      Look: 'attractive face',
    })
    const result = failed(run([{ prompt: v17, aspectRatio: '3:4' }]), { count: 1, gender: 'woman' })
    expect(result).toContain('Look line copied word for word')
    expect(result).toContain('no glow, dewy, luminous or radiant skin words')
  })

  it('ignores "shiny" inside the Avoid line, which the skill writes on purpose', () => {
    const calls = run([{ prompt: prompt(), aspectRatio: '3:4' }])
    expect(failed(calls, { count: 1 })).toEqual([])
  })

  it('flags the man half used for a woman, missing labels, wrong ratio and repeated people', () => {
    const manLook = LOOK.replace(/<[^>]*>/, 'pretty').replace(/ for a woman [^;]+;/, '')
    const same = prompt({ Look: manLook, Wardrobe: '' })
    const result = failed(run([{ prompt: same, aspectRatio: '1:1' }, { prompt: same, aspectRatio: '3:4' }]), { count: 2, gender: 'woman' })
    expect(result).toEqual(expect.arrayContaining([
      'every portrait is 3:4',
      'every labeled line is present',
      'Look line uses the woman half',
      'each portrait is a different person',
    ]))
  })

  it('requires the skill first, the roll before generation, and one call', () => {
    const items = [{ prompt: prompt(), aspectRatio: '3:4' }]
    const calls: AvatarPromptCall[] = [
      { toolName: 'generate_image', args: items[0] },
      { toolName: 'roll_avatar_variations', args: {} },
      { toolName: 'generate_image', args: items[0] },
    ]
    expect(failed(calls, { count: 1 })).toEqual(expect.arrayContaining([
      'loads the skill first',
      'rolls variations before generating',
      'asks for 1 portrait in one call',
    ]))
  })

  it('checks full-body framing and the reference photo when the brief asks', () => {
    const items = [{ prompt: prompt(), aspectRatio: '3:4', referenceFileIds: ['other'] }]
    expect(failed(run(items), { count: 1, framing: 'full body', referenceFileId: 'ref-1' })).toEqual([
      'full-body framing',
      'every portrait uses the reference photo',
    ])
  })
})

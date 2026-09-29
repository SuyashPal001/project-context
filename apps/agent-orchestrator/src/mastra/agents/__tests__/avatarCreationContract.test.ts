import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AVATAR_CREATION_SECTION, AVATAR_FROM_IMAGE_SECTION, DIRECTOR_WORKING_MEMORY_SECTION } from '../directorAgent.js'

// The Avatar creation and Image-to-avatar contracts moved out of Olmo's
// always-on instructions into the Avatar creator Official skill (see
// platformAgent.ts's OFFICIAL_SKILL_POINTERS). The verbatim contract text now
// lives in this seed file, moved unchanged — these assertions moved with it.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AVATAR_CREATOR_SKILL_PATH = path.resolve(
  __dirname,
  '../../../../../../products/agent-platform/packages/api/seeds/official-skills/avatar-creator.md',
)

let AVATAR_SKILL_TEXT: string

beforeAll(() => {
  expect(existsSync(AVATAR_CREATOR_SKILL_PATH)).toBe(true)
  AVATAR_SKILL_TEXT = readFileSync(AVATAR_CREATOR_SKILL_PATH, 'utf8')
})

describe('avatar creation contract (Avatar creator Official skill)', () => {
  it('caps intake at one card of at most three multiple-choice questions and forbids a demographic quiz', () => {
    expect(AVATAR_SKILL_TEXT).toContain('at most ONE ask_clarifying_questions card')
    expect(AVATAR_SKILL_TEXT).toContain('at most three single-select questions')
    expect(AVATAR_SKILL_TEXT).toMatch(/never a bare free-text question/i)
    expect(AVATAR_SKILL_TEXT).toContain('(Recommended)')
    expect(AVATAR_SKILL_TEXT).toMatch(/never ask separately about gender or age, never ask about ethnicity except as question 3/i)
    expect(AVATAR_SKILL_TEXT).toContain('"A mix — 4 different looks (Recommended)" and "Indian"')
    expect(AVATAR_SKILL_TEXT).toMatch(/Skip the whole card only when the brief already says both what the avatar is for and the look/)
    expect(AVATAR_SKILL_TEXT).toMatch(/never infer .* from a name/i)
  })

  it('makes the four variations real alternatives in 3:4, stated in the plan before approval', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/the look is "a mix" — four clearly different people/i)
    expect(AVATAR_SKILL_TEXT).toMatch(/pass aspectRatio "3:4" to agent-director, never 1:1/i)
    expect(AVATAR_SKILL_TEXT).toMatch(/The plan names who the four will be/)
    expect(AVATAR_SKILL_TEXT).toMatch(/one plain "Who:" line before the cost/)
    expect(AVATAR_SKILL_TEXT).toMatch(/otherwise 22–45\. Never narrow it yourself/)
    expect(AVATAR_SKILL_TEXT).toMatch(/state the look, the gender \(or "any"\) and the age range exactly as in the plan/)
    expect(AVATAR_CREATION_SECTION).toMatch(/never narrow it yourself/)
    expect(AVATAR_CREATION_SECTION).toMatch(/Always use aspectRatio "3:4" for these four/)
    expect(AVATAR_CREATION_SECTION).toMatch(/Never four near-identical people/)
    expect(AVATAR_CREATION_SECTION).toMatch(/never add freckles unless the brief asks for them/)
  })

  it('writes each variation prompt as a labeled phone-video frame caught mid-sentence, with an avoid list', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/caught mid-sentence — never a posed portrait or headshot/)
    for (const label of ['Use case:', 'Scene/backdrop:', 'Subject:', 'Wardrobe:', 'Style/medium:', 'Composition/framing:', 'Constraints:', 'Avoid:']) {
      expect(AVATAR_CREATION_SECTION).toContain(label)
    }
    expect(AVATAR_CREATION_SECTION).toMatch(/Avoid: posed stock headshot/)
    expect(AVATAR_CREATION_SECTION).toMatch(/phone screen, phone bezel, status bar, recording icon or any camera UI/)
    expect(AVATAR_CREATION_SECTION).not.toMatch(/relaxed natural expression/)
    expect(AVATAR_CREATION_SECTION).toMatch(/eyes looking straight into the lens, never off to the side/)
  })

  it('rolls distinct details in code before writing the variations, with the brief winning over the roll', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/call roll_avatar_variations once/)
    expect(AVATAR_CREATION_SECTION).toMatch(/the brief wins over the roll/)
  })

  it('never claims an avatar was saved, or names it, without a successful save_as_avatar result', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/Only say the avatar is saved when Director reports a save_as_avatar result with saved true/)
    expect(AVATAR_SKILL_TEXT).toMatch(/never make up a name/)
    expect(AVATAR_SKILL_TEXT).toMatch(/the avatar was NOT saved/)
  })

  it('delegates by calling the agent-director tool, never by writing a request to it', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/Delegate by calling the agent-director tool — never by writing a message to it in your reply/)
  })

  it('records the avatar brief under Key Decisions only, and Director leaves working memory alone', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/under Key Decisions only — never in Brand Context or User Preferences/)
    expect(DIRECTOR_WORKING_MEMORY_SECTION).toMatch(/never set User Preferences or Brand Context/)
  })

  it('requires fresh approval before regenerating rejected variations', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/none of these/i)
    expect(AVATAR_SKILL_TEXT).toMatch(/fresh cost estimate, fresh approval/i)
  })

  it('shows the reference sheet during testing and saves via save_as_avatar', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/show the reference sheet/i)
    expect(AVATAR_CREATION_SECTION).toContain('save_as_avatar')
    expect(AVATAR_CREATION_SECTION).toContain('generate_images')
    expect(AVATAR_CREATION_SECTION).toMatch(/referenceSheet is false/i)
  })

  it('never offers to regenerate a failed reference sheet — save_as_avatar always creates a new avatar, so accepting would duplicate it', () => {
    expect(AVATAR_SKILL_TEXT).not.toMatch(/offer to regenerate/i)
  })

  it('tells Olmo to pass the picked portrait\'s fileId explicitly to Director, since Director cannot see Olmo\'s working memory', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/pass that fileId explicitly/i)
  })

  it('sets each pick option\'s imageFileId to its own variation, so the user sees the actual faces instead of bare "Option N" text', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/imageFileId/)
    expect(AVATAR_SKILL_TEXT).toMatch(/Option 1 = the first variation's fileId/i)
    expect(AVATAR_SKILL_TEXT).toMatch(/never set imageFileId on the "None of these" option/i)
  })

  it('limits demographic inference to what the user or the product\'s stated audience explicitly says, never a market or region', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/product's stated audience states/i)
    expect(AVATAR_SKILL_TEXT).not.toMatch(/product's stated audience implies/i)
    expect(AVATAR_SKILL_TEXT).toMatch(/never infer ethnicity from a market or region/i)
  })

  it('keeps terseTag and styleLock short — they are matched byte-for-byte in later prompts', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/terseTag \(10.40 characters/i)
    expect(AVATAR_CREATION_SECTION).toMatch(/styleLock \(under 80 characters/i)
    expect(AVATAR_CREATION_SECTION).toMatch(/never a name: save_as_avatar picks the avatar's name/)
    expect(AVATAR_CREATION_SECTION).not.toMatch(/"Riya,/)
  })

  it('draws the reference sheet as plain photo crops with a complete everyday outfit', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/never a cut-out or circle-cropped floating bust/)
    expect(AVATAR_CREATION_SECTION).toMatch(/everyday bottoms and shoes/)
    // "three-quarter left, three-quarter right" was read as the same side twice.
    expect(AVATAR_CREATION_SECTION).toMatch(/turned toward the viewer's LEFT/)
    expect(AVATAR_CREATION_SECTION).toMatch(/turned toward the viewer's RIGHT, the mirror of panel 2/)
  })
})

describe('image-to-avatar contract (Avatar creator Official skill)', () => {
  it('offers the two intents as a single-select question with the exact option labels', () => {
    expect(AVATAR_SKILL_TEXT).toContain('Same person, restyled')
    expect(AVATAR_SKILL_TEXT).toContain('A new person with this look')
  })

  it('never recreates a recognizable public figure — redirects to inspired-by instead', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/never recreate a recognizable public figure/i)
  })

  it('passes the image fileId to Director explicitly, together with the intent and the brief', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/pass .*fileId/i)
  })

  it('generates variations with referenceFileIds set to the user\'s image', () => {
    expect(AVATAR_FROM_IMAGE_SECTION).toContain('referenceFileIds')
  })

  it('inspired-by variations create a different person than the one in the reference', () => {
    expect(AVATAR_FROM_IMAGE_SECTION).toMatch(/different person, not the person in the reference/i)
  })

  it('uses the picked portrait — not the original photo — as the reference sheet\'s only reference', () => {
    expect(AVATAR_FROM_IMAGE_SECTION).toMatch(/picked portrait as its only reference/i)
  })

  // Finding #1: inspired-by must not anchor the new person to the reference's
  // identity — the section must tell Olmo to set skipAvatarExpansion.
  it('tells Olmo to set skipAvatarExpansion for the inspired-by intent', () => {
    expect(AVATAR_FROM_IMAGE_SECTION).toContain('skipAvatarExpansion')
  })

  it('keeps avatar variations off Olmo\'s direct single-image path so they go out as one batch', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/never call your own generate_image/i)
    expect(AVATAR_SKILL_TEXT).toMatch(/ONE generate_images batch/)
  })
})

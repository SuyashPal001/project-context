import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AVATAR_CREATION_SECTION, AVATAR_FROM_IMAGE_SECTION, DIRECTOR_WORKING_MEMORY_SECTION, TVC_CHARACTER_SECTION } from '../directorAgent.js'

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
    // Portraits become the first frame of talking videos: a relaxed, slightly open mouth, not mid-word.
    expect(AVATAR_CREATION_SECTION).toMatch(/lips slightly parted and relaxed, not wide open/)
    expect(AVATAR_CREATION_SECTION).toMatch(/a wide-open mouth mid-word/)
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
    // Full-body framing for avatars whose outfit or body is the product.
    expect(AVATAR_SKILL_TEXT).toMatch(/Framing: full body when the outfit or body is part of what the avatar sells/)
    expect(AVATAR_CREATION_SECTION).toMatch(/When Olmo's brief says "framing: full body"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/the face large and sharp enough to read clearly/)
    expect(AVATAR_CREATION_SECTION).toMatch(/turned toward the viewer's RIGHT, the mirror of panel 2/)
  })
})

describe('animated-character avatars (Animated character creator Official skill)', () => {
  const CHARACTER_SKILL_TEXT = () => readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../animated-character-creator.md'), 'utf8')

  it('is its own skill, leaving the tested Avatar creator skill unchanged', () => {
    expect(AVATAR_SKILL_TEXT).not.toMatch(/Animated character/)
    expect(CHARACTER_SKILL_TEXT()).toMatch(/Use the Avatar creator skill/i)
  })

  it('asks what kind of character in one card and passes the style and kind to Director', () => {
    const text = CHARACTER_SKILL_TEXT()
    expect(text).toContain('at most ONE ask_clarifying_questions card')
    expect(text).toContain('"Cozy 3D mascot — a little creature or object (Recommended)", "Game hero — fantasy or sci-fi console-game art", "Cinematic anime — elegant hand-drawn 2D anime", "Fantasy anime — anime game-art heroes", "3D chibi — cute family-film characters" and "Storybook anime — warm hand-painted everyday life"')
    expect(text).toMatch(/write "style: animated character" for a mascot, "style: game hero" for a game hero "style: cinematic anime" for cinematic anime "style: fantasy anime" for fantasy anime "style: 3d chibi" for 3D chibi or "style: storybook anime" for storybook anime/)
    expect(text).toMatch(/Never ask about gender, age or ethnicity/)
    expect(text).toMatch(/Never recreate an existing cartoon character or another brand's mascot/)
    expect(text).toMatch(/Delegate by calling the agent-director tool — never by writing a message to it in your reply/)
    expect(text).toMatch(/ONE generate_images batch/)
    expect(text).toMatch(/Only say the character is saved when Director reports a save_as_avatar result with saved true/)
    expect(text).toMatch(/under Key Decisions only/)
  })

  it('rolls characters by kind, writes a 3D mascot prompt and a full-body turnaround sheet', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/when Olmo's brief says "style: animated character"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/Call roll_character_variations once instead, with style "mascot" and kind "creatures", "objects" or "mix"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/ONE full-body portrait of an original <character> character/)
    expect(AVATAR_CREATION_SECTION).toMatch(/plain <backdrop> studio backdrop with a soft grounded shadow/)
    expect(AVATAR_CREATION_SECTION).toMatch(/resemblance to any existing famous animated character or brand mascot/)
    expect(AVATAR_CREATION_SECTION).toMatch(/The quality bar, as one approved example/)
    expect(AVATAR_CREATION_SECTION).toMatch(/a small mouth, relaxed and slightly open, so it can later talk in a video/)
    expect(AVATAR_CREATION_SECTION).toMatch(/five full-body panels left to right/)
    expect(AVATAR_CREATION_SECTION).toMatch(/\(5\) back view/)
    expect(AVATAR_CREATION_SECTION).toMatch(/skipAvatarExpansion true on every item/)
  })

  it('writes game heroes as original console-game character art with no brand logos', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/when Olmo's brief says "style: game hero"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/with style "game hero" and the brief's gender/)
    expect(AVATAR_CREATION_SECTION).toMatch(/premium contemporary AAA console-game character art/)
    expect(AVATAR_CREATION_SECTION).toMatch(/no visible brand logos on clothes or shoes/)
    expect(AVATAR_CREATION_SECTION).toMatch(/same full costume and signature item in every panel/)
  })

  it('draws cinematic anime as clearly adult, ad-safe, visibly hand-drawn 2D', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/when Olmo's brief says "style: cinematic anime"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/clearly adult in face and proportions/)
    expect(AVATAR_CREATION_SECTION).toMatch(/tasteful and ad-safe, with no fantasy armour or weapons/)
    expect(AVATAR_CREATION_SECTION).toMatch(/visibly hand-drawn anime, never semi-realistic digital painting or 3D/)
    expect(AVATAR_CREATION_SECTION).toMatch(/childlike features; revealing or suggestive framing/)
  })

  it('draws fantasy anime as full-body adult game key art, one character with no mounts', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/when Olmo's brief says "style: fantasy anime"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/premium hand-painted 2D anime game key art/)
    expect(AVATAR_CREATION_SECTION).toMatch(/from head to feet with no cropped feet/)
    expect(AVATAR_CREATION_SECTION).toMatch(/one character only, with no creatures or mounts/)
  })

  it('keeps 3D chibi characters fully clothed, modest and age-appropriate', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/when Olmo's brief says "style: 3d chibi"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/fully clothed, age-appropriate and modest/)
    expect(AVATAR_CREATION_SECTION).toMatch(/never mature styling/)
    expect(AVATAR_CREATION_SECTION).toMatch(/rounded chibi proportions with a large head on a small body/)
    expect(AVATAR_CREATION_SECTION).toMatch(/cute and warm, never angry or intimidating/)
  })

  it('paints storybook anime as warm hand-painted everyday moments without naming a studio', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/when Olmo's brief says "style: storybook anime"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/caught in a quiet everyday moment <moment>/)
    expect(AVATAR_CREATION_SECTION).toMatch(/soft painterly backgrounds with a watercolour texture/)
    expect(AVATAR_CREATION_SECTION).not.toMatch(/ghibli/i)
    expect(AVATAR_CREATION_SECTION).toMatch(/never reproducing any existing studio, film, character or artwork/)
  })
})

describe('TVC character creator (Official skill)', () => {
  const TVC_SKILL_TEXT = () => readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../tvc-character-creator.md'), 'utf8')

  it('asks one card, never recreates a celebrity, and delegates the style to Director', () => {
    const text = TVC_SKILL_TEXT()
    expect(text).toContain('at most ONE ask_clarifying_questions card')
    expect(text).toMatch(/Never recreate a real celebrity, actor or public figure/)
    expect(text).toMatch(/write "style: tvc"/)
    expect(text).toMatch(/ONE generate_images batch/)
    expect(text).toMatch(/Only say the actor is saved when Director reports a save_as_avatar result with saved true/)
    expect(text).toMatch(/under Key Decisions only/)
    expect(text).toMatch(/Delegate by calling the agent-director tool — never by writing a message to it in your reply/)
  })

  it('casts original commercial actors and builds an eight-section continuity bible at 2K', () => {
    expect(TVC_CHARACTER_SECTION).toMatch(/call roll_tvc_variations once/)
    expect(TVC_CHARACTER_SECTION).toMatch(/an original face that never resembles any celebrity, actor or public figure/)
    expect(TVC_CHARACTER_SECTION).toMatch(/aspectRatio "3:4", imageSize "2K"/)
    for (const section of ['CHARACTER PROFILE', 'FULL-BODY TURNAROUND', 'FACE & IDENTITY DETAILS', 'EXPRESSION SHEET', 'POSE & BODY LANGUAGE', 'COSTUME DETAILS', 'COLOR & MATERIAL PALETTE', 'DO NOT CHANGE']) {
      expect(TVC_CHARACTER_SECTION).toContain(section)
    }
    expect(TVC_CHARACTER_SECTION).toMatch(/no personal name anywhere on the page/)
    expect(TVC_CHARACTER_SECTION).toMatch(/lips relaxed and slightly parted/)
  })

  it('follows the approved Aroha prompts: real-camera face, one-person stills, a face refinement before the sheet', () => {
    expect(TVC_CHARACTER_SECTION).toMatch(/distinctive, non-celebrity face/)
    expect(TVC_CHARACTER_SECTION).toMatch(/no reference sheet, grid, extra angles or labels/)
    expect(TVC_CHARACTER_SECTION).toMatch(/a polished AI beauty face, a glassy stare, a face-sculpting filter/)
    expect(TVC_CHARACTER_SECTION).toMatch(/Face refinement, after the user picks and before the continuity bible: one edit_image call/)
    expect(TVC_CHARACTER_SECTION).toMatch(/relaxed front three-quarter standing pose, hands resting naturally together at waist level/)
    const text = readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../tvc-character-creator.md'), 'utf8')
    expect(text).toMatch(/1 face refinement and 1 character reference sheet/)
    expect(text).toMatch(/pass it to agent-director as "framing: full body" or "framing: mid-thigh up"/)
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

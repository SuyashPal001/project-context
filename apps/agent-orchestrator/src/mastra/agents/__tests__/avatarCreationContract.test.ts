import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AVATAR_CREATION_SECTION as AVATAR_CREATION_BASE, DIRECTOR_WORKING_MEMORY_SECTION } from '../directorAgent.js'

// The Avatar creation and Image-to-avatar contracts moved out of Olmo's
// always-on instructions into the Avatar creator Official skill (see
// platformAgent.ts's OFFICIAL_SKILL_POINTERS). The verbatim contract text now
// lives in this seed file, moved unchanged — these assertions moved with it.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AVATAR_CREATOR_SKILL_PATH = path.resolve(
  __dirname,
  '../../../../../../products/agent-platform/packages/api/seeds/official-skills/ugc-avatar-creator.md',
)

let AVATAR_SKILL_TEXT: string
// Director's TVC rules moved, word for word, out of directorAgent.ts into the
// TVC skill's own folder; Director loads them as a native Mastra skill.
let TVC_CHARACTER_SECTION: string
// Avatar creation is split the same way: shared mechanics, sheet and save stay
// in Director (AVATAR_CREATION_BASE); the realistic presenter prompt and
// image-to-avatar moved to ugc-avatar-creator/director.md, and every animated
// style to animated-character-creator/director.md. These assertions read all
// three together, as Director sees them once a skill loads.
let AVATAR_CREATION_SECTION: string
let AVATAR_FROM_IMAGE_SECTION: string
let REALISTIC_DIRECTOR: string
let ANIMATED_DIRECTOR: string

beforeAll(() => {
  expect(existsSync(AVATAR_CREATOR_SKILL_PATH)).toBe(true)
  AVATAR_SKILL_TEXT = readFileSync(AVATAR_CREATOR_SKILL_PATH, 'utf8')
  TVC_CHARACTER_SECTION = readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../tvc-character-creator/director.md'), 'utf8')
  REALISTIC_DIRECTOR = readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../ugc-avatar-creator/director.md'), 'utf8')
  ANIMATED_DIRECTOR = readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../animated-character-creator/director.md'), 'utf8')
  AVATAR_CREATION_SECTION = AVATAR_CREATION_BASE + REALISTIC_DIRECTOR + ANIMATED_DIRECTOR
  AVATAR_FROM_IMAGE_SECTION = REALISTIC_DIRECTOR
})

describe('style rules split into their skills', () => {
  it('keeps only shared mechanics, sheet and save in Director', () => {
    expect(AVATAR_CREATION_BASE).toContain('Step edit only')
    expect(AVATAR_CREATION_BASE).toContain('Reference sheet, after the user picks')
    expect(AVATAR_CREATION_BASE).toContain('Call save_as_avatar')
    expect(AVATAR_CREATION_BASE).not.toContain('roll_avatar_variations once')
    expect(AVATAR_CREATION_BASE).not.toContain('style: cinematic anime')
    expect(AVATAR_CREATION_BASE).not.toContain('handmade stop-motion claymation')
  })

  it('keeps realistic rules out of the animated skill and animated rules out of the realistic one', () => {
    expect(REALISTIC_DIRECTOR).toContain('roll_avatar_variations once')
    expect(REALISTIC_DIRECTOR).toContain('## Image-to-avatar')
    expect(REALISTIC_DIRECTOR).not.toContain('style: claymation')
    expect(ANIMATED_DIRECTOR).toContain('style: cinematic anime')
    expect(ANIMATED_DIRECTOR).not.toContain('Use case: photorealistic-natural')
    expect(ANIMATED_DIRECTOR).not.toContain('## Image-to-avatar')
  })

  it('has Olmo send the style line on every Director call, so the right rules load', () => {
    expect(AVATAR_SKILL_TEXT).toContain('includes the line "style: realistic avatar"')
    expect(readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../animated-character-creator.md'), 'utf8')).toContain('includes the style line above')
    expect(readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../tvc-character-creator.md'), 'utf8')).toContain('includes "style: tvc"')
  })
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

  // The pick used to be a blocking image card, which held the turn open ("Working for Ns")
  // while the user decided. Now the four are shown in the chat and the turn ends; the
  // user's next message picks by number or asks for a change.
  it('shows the four in the chat and ends the turn, so the pick comes in the next message', () => {
    expect(AVATAR_SKILL_TEXT).toMatch(/list them as "1\. <title>" to "4\. <title>"/)
    expect(AVATAR_SKILL_TEXT).toMatch(/In the next turn, a number .* is the pick, mapped to that variation's fileId/)
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
    expect(CHARACTER_SKILL_TEXT()).toMatch(/Use the UGC avatar creator skill/i)
  })

  it('asks what kind of character in one card and passes the style and kind to Director', () => {
    const text = CHARACTER_SKILL_TEXT()
    expect(text).toContain('at most ONE ask_clarifying_questions card')
    expect(text).toContain('"Cozy 3D mascot — a little creature or object (Recommended)", "Game hero — fantasy or sci-fi console-game art", "Cinematic anime — elegant hand-drawn 2D anime", "Fantasy anime — anime game-art heroes", "3D chibi — cute family-film characters", "Storybook anime — warm hand-painted everyday life", "Pixar-style 3D — warm animated-film people" and "Claymation — handmade stop-motion clay"')
    expect(text).toMatch(/write "style: animated character" for a mascot, "style: game hero" for a game hero "style: cinematic anime" for cinematic anime "style: fantasy anime" for fantasy anime "style: 3d chibi" for 3D chibi, "style: storybook anime" for storybook anime, or "style: pixar 3d" or "style: claymation" for those/)
    expect(text).toMatch(/2D flat is not offered as an avatar style/)
    expect(text).not.toContain('"2D flat — bold vector illustration"')
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

  it('offers Pixar-style 3D, 2D flat and claymation in the same looks the animated ad flow renders', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/"style: pixar 3d", "style: 2d flat" or "style: claymation"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/STYLE "3d_pixar", "2d_flat" or "claymation" block/)
    expect(AVATAR_CREATION_SECTION).toMatch(/stop-motion claymation look, visible clay or plasticine texture/)
  })

  it('makes claymation a matte plasticine puppet on a plain cloth backdrop, quirky but with both eyes open, and keeps the clay in the sheet', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/- Claymation, on top of the rules above/)
    expect(AVATAR_CREATION_SECTION).toMatch(/visible thumbprints and sculpting-tool marks/)
    expect(AVATAR_CREATION_SECTION).toMatch(/no set or props behind the character/)
    expect(AVATAR_CREATION_SECTION).toMatch(/Avoid: glossy plastic sheen, smooth CGI render.*a winking or closed eye, a hand on the face, kneeling or sitting/)
    expect(AVATAR_CREATION_SECTION).toMatch(/never smoothed into a CGI render/)
  })

  it('keeps a chunkier toy-like cute claymation for kids beside the detailed claymation', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/- Cute claymation: when Olmo's brief says "style: cute claymation"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/chunky toy-like stop-motion clay figure/)
    const skill = readFileSync(AVATAR_CREATOR_SKILL_PATH.replace('ugc-avatar-creator.md', 'animated-character-creator.md'), 'utf8')
    expect(skill).toMatch(/Claymation is ONE option on the card too, with two looks you choose from the answers/)
    expect(skill).not.toContain('"Cute claymation — chunky toy-like clay for kids"')
    expect(AVATAR_CREATION_SECTION).toMatch(/- Everything is clay, for claymation and cute claymation alike/)
    expect(skill).toContain('("style: cute claymation" for cute claymation,')
  })

  it('offers 3D family film and 3D movie drama beside Pixar-style 3D, always full length', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/- 3D family film and 3D movie drama: when Olmo's brief says "style: 3d family film" or "style: 3d movie drama"/)
    expect(AVATAR_CREATION_SECTION).toMatch(/an attractive, glamorous stylised adult with near-real adult body proportions/)
    expect(AVATAR_CREATION_SECTION).toMatch(/never cropped at the knees, thighs or waist/)
    expect(AVATAR_CREATION_SECTION).toMatch(/a childlike or teenage face/)
    expect(AVATAR_CREATION_SECTION).toMatch(/never rounder, younger or cuter/)
    const skill = readFileSync(AVATAR_CREATOR_SKILL_PATH.replace('ugc-avatar-creator.md', 'animated-character-creator.md'), 'utf8')
    expect(skill).toContain('"style: 3d family film" or "style: 3d movie drama" for those')
    expect(skill).toMatch(/Pixar-style 3D is ONE option on the card, but it has three looks, and you choose the look from the answers/)
    expect(skill).toMatch(/Name the look you chose in the plan's "Who:" line with one short reason/)
    expect(skill).not.toContain('"3D movie drama — glamorous adults"')
  })

  it('keeps one described character inside its style, and the preferences card too', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/the description fills the slots \(who, hair, outfit, place, mood\) and never replaces the look/)
    expect(AVATAR_CREATION_SECTION).toMatch(/move it into the style's world while keeping its intent/)
    const skill = readFileSync(AVATAR_CREATOR_SKILL_PATH.replace('ugc-avatar-creator.md', 'animated-character-creator.md'), 'utf8')
    expect(skill).toMatch(/Preferences stay inside the chosen style/)
    expect(skill).toMatch(/settings are night-city places/)
  })

  it('opens both eyes and relaxes the pose in every animated turnaround panel, even when the still winks', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/In every panel both eyes are fully open.*even when the picked still winks, squints, grins or poses/)
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
    expect(TVC_CHARACTER_SECTION).toMatch(/after the user picks and before the continuity bible: one edit_image call/)
    expect(TVC_CHARACTER_SECTION).toMatch(/relaxed front three-quarter standing pose, hands resting naturally together at waist level/)
    const text = readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../tvc-character-creator.md'), 'utf8')
    expect(text).toMatch(/then after the pick 1 character reference sheet/)
    expect(text).toMatch(/Framing: always full body, head to toe/)
    expect(text).toMatch(/Casting fits the product/)
    expect(TVC_CHARACTER_SECTION).toMatch(/with category from what Olmo says the actor is for/)
    expect(TVC_CHARACTER_SECTION).toMatch(/Signature anchor: <anchor>/)
    expect(TVC_CHARACTER_SECTION).toMatch(/never exaggerated, theatrical, gurning or cartoonish/)
    expect(text).toMatch(/"Just one — I'll describe them"/)
    expect(text).toMatch(/Delegate with "count: 1"/)
    expect(text).toMatch(/"Any preferences for them\?" card/)
    expect(text).toMatch(/"No preference — you choose"/)
    expect(text).toMatch(/Always give a recommendation: on every question of every card in this skill/)
    expect(text).toMatch(/call check_credit_plan for the four-option plan/)
    expect(text).toMatch(/Work one step at a time, never back to back/)
    expect(text).toMatch(/The face refinement is optional and never in the plan's total/)
    expect(text).toMatch(/Never refine the face unasked/)
    expect(text).toMatch(/One step at a time: after every generation step/)
    expect(text).toMatch(/happy with this face — reply "looks good"/)
    expect(TVC_CHARACTER_SECTION).toMatch(/"step: refine face only"/)
    expect(TVC_CHARACTER_SECTION).toMatch(/"step: sheet and save", skip the refinement/)
    for (const skill of [AVATAR_SKILL_TEXT, readFileSync(path.resolve(AVATAR_CREATOR_SKILL_PATH, '../animated-character-creator.md'), 'utf8')]) {
      expect(skill).toMatch(/How many options — ask everywhere/)
      expect(skill).toMatch(/"Just one — I'll describe it"/)
      expect(skill).toMatch(/Always give a recommendation/)
      expect(skill).toMatch(/One step at a time: after every generation step/)
      expect(skill).toMatch(/Refine one change at a time, never rush to the sheet/)
      expect(skill).toMatch(/Never call ask_clarifying_questions here/)
    }
    expect(AVATAR_CREATION_SECTION).toMatch(/when Olmo's brief says "count: 1", every variation step/)
    expect(AVATAR_CREATION_SECTION).toMatch(/"step: edit only", call edit_image once on the given fileId/)
    expect(TVC_CHARACTER_SECTION).toMatch(/exactly 1 when Olmo's brief says "count: 1"/)
    expect(TVC_CHARACTER_SECTION).toMatch(/Composition\/framing: always full body/)
    expect(TVC_CHARACTER_SECTION).not.toMatch(/from mid-thigh up/)
    expect(TVC_CHARACTER_SECTION).toMatch(/a full-length, head-to-toe casting still/)
    expect(TVC_CHARACTER_SECTION).toMatch(/35mm lens at waist height/)
    expect(TVC_CHARACTER_SECTION).not.toMatch(/85mm lens, shallow depth of field/)
    expect(TVC_CHARACTER_SECTION).toMatch(/Avoid: cropping at the knees, thighs or waist, missing feet/)
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

describe('consistency: changes to an existing image are edits, closer framings are free crops', () => {
  it('Director never regenerates a kept still', async () => {
    const { readFileSync } = await import('node:fs')
    const director = readFileSync(path.resolve(__dirname, '../directorAgent.ts'), 'utf8')
    expect(director).toMatch(/Consistency rule, for every image in every flow/)
    expect(director).toMatch(/Never answer it with generate_image/)
    expect(AVATAR_CREATION_SECTION).toMatch(/never generate_image, which would invent a new person and outfit/)
    const olmo = readFileSync(path.resolve(__dirname, '../platformAgent.ts'), 'utf8')
    expect(olmo).toMatch(/is never a plain image request: it is an edit of that image/)
    expect(olmo).toMatch(/crop_image: cropImage/)
  })
})

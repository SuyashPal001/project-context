import { describe, it, expect, beforeAll } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { platformAgent } from '../platformAgent.js'

// The Talking-head contract moved out of Olmo's always-on instructions into
// the Talking head Official skill (see platformAgent.ts's
// OFFICIAL_SKILL_POINTERS). The verbatim contract text now lives in this
// seed file, moved unchanged — these assertions moved with it.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TALKING_HEAD_SKILL_PATH = path.resolve(
  __dirname,
  '../../../../../../products/agent-platform/packages/api/seeds/official-skills/talking-head.md',
)

let TALKING_HEAD_SKILL_TEXT: string
// The UGC character, template video, UGC first-frame, animation-character and
// short-drama-stitch contracts moved word for word into Official skills too.
// Tests that read them from Olmo's prompt read the skill files alongside it.
let FLOW_SKILLS_TEXT: string

beforeAll(() => {
  expect(existsSync(TALKING_HEAD_SKILL_PATH)).toBe(true)
  TALKING_HEAD_SKILL_TEXT = readFileSync(TALKING_HEAD_SKILL_PATH, 'utf8')
  FLOW_SKILLS_TEXT = ['ugc-character-ad', 'template-video', 'ugc-first-frame', 'animation-character-ad', 'short-drama-stitch']
    .map((slug) => readFileSync(path.resolve(TALKING_HEAD_SKILL_PATH, '..', `${slug}.md`), 'utf8'))
    .join('\n\n')
})

describe('ad flows load as Official skills', () => {
  it('keeps the five flow contracts out of Olmo\'s always-on prompt and points to each skill', async () => {
    const instructions = await platformAgent.getInstructions({ requestContext: new RequestContext() })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    for (const header of ['## UGC character ad —', '## Template video cloning —', '## UGC first-frame ad —', '## Animation-character ad —', '## Short-drama-stitch ad —']) {
      expect(text).not.toContain(header)
    }
    for (const skill of ['UGC character ad skill', 'Template video skill', 'UGC first frame skill', 'Animated story ad skill', 'Short-drama stitch skill']) {
      expect(text).toContain(`load the ${skill}`)
    }
  })
})

describe('Talking head Official skill contract text', () => {
  it('contains the Talking-head ad contract header', () => {
    expect(TALKING_HEAD_SKILL_TEXT).toContain('## Talking-head ad — intake, narration lock, and delivery')
  })

  it('narration lock — the contract requires locking BOTH fileId and durationSeconds, and restating them on every later delegation', () => {
    expect(TALKING_HEAD_SKILL_TEXT).toContain('Locked Reference Artifact IDs')
    expect(TALKING_HEAD_SKILL_TEXT).toContain('durationSeconds')
    expect(TALKING_HEAD_SKILL_TEXT).toMatch(/[Rr]estate this locked narration fileId and durationSeconds/)
    expect(TALKING_HEAD_SKILL_TEXT).toContain('Never re-delegate a fresh generate_narration call')
  })

  it('states the up-front multi-confirmation cost warning and the board gate', () => {
    expect(TALKING_HEAD_SKILL_TEXT).toMatch(/8-10 separate cost confirmations/)
    expect(TALKING_HEAD_SKILL_TEXT).toMatch(/present them together and ask the user to approve the set as a whole/)
    expect(TALKING_HEAD_SKILL_TEXT).toMatch(/deliberate visible cut/)
  })
})

describe('platformAgent instructions — talking-head contract', () => {
  it('routes single-continuous-presenter requests away from the UGC character contract', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT

    const ugcIdx = text.indexOf('## UGC character ad')
    expect(ugcIdx).toBeGreaterThanOrEqual(0)
    // The UGC contract's own trigger line must still explicitly route a
    // single-continuous-presenter request to the talking-head flow, even
    // though that flow now lives in the Talking head Official skill rather
    // than a contract composed into these same instructions.
    const ugcTriggerLine = text.slice(ugcIdx, ugcIdx + 600)
    expect(ugcTriggerLine).toContain('Talking-head ad contract')
  })
})

describe('platformAgent instructions — Official skill pointers', () => {
  it('no longer composes the Avatar creation or Talking-head ad contracts directly into instructions', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    expect(text).not.toContain('## Avatar creation — a reusable presenter')
    expect(text).not.toContain('## Talking-head ad —')
  })

  it('includes the Official skill pointers section', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    expect(text).toContain('## Official skills')
    expect(text).toMatch(/load the UGC avatar creator skill/i)
    expect(text).toMatch(/load the Talking head skill/i)
    expect(text).toMatch(/load the TVC ad skill/i)
  })

  it('asks which kind of avatar on a plain request even with no avatar skill turned on', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    expect(text).toMatch(/with no avatar skill turned on: when the user asks for a new avatar, presenter or character/)
    expect(text).toMatch(/ask that same one question before loading any avatar skill/)
    expect(text).toMatch(/Skip the question when their words already say the kind/)
    // The existing rule for several skills turned on stays as it was.
    expect(text).toMatch(/If more than one avatar skill \(UGC avatar creator, Animated character creator, TVC character creator\) is turned on/)
  })
})

describe('platformAgent instructions — credit-confirmation contract, no backend ids or LaTeX', () => {
  it('forbids opaque identifiers in plans and replies, while requiring exact id pass-through internally', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const costIdx = text.indexOf('## Credit-spending confirmation')
    expect(costIdx).toBeGreaterThanOrEqual(0)
    const nextSectionIdx = text.indexOf('\n\n## ', costIdx + 1)
    const section = text.slice(costIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)

    // Forbidden in what the user sees.
    expect(section).toMatch(/file ids, voice ids, template slugs/)
    expect(section).toMatch(/UUIDs/)
    // But ids still pass through exactly in delegation/tool calls/working memory.
    expect(section).toMatch(/pass every id exactly and unchanged/)
    expect(section).toContain('exact fileId, Voice ID and template-slug pass-through')
    expect(section).toContain('ask_clarifying_questions: its option labels and rationales are shown to the user')
  })

  it('does not ask the model to name a delegate/model in the plan (resolves the delegate-line contradiction)', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const costIdx = text.indexOf('## Credit-spending confirmation')
    const nextSectionIdx = text.indexOf('\n\n## ', costIdx + 1)
    const section = text.slice(costIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)

    expect(section).not.toMatch(/which delegate\/model handles it/)
    expect(section).toContain('skip any "Delegate/Model" line')
  })

  it('bans LaTeX in plans and replies', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const costIdx = text.indexOf('## Credit-spending confirmation')
    const nextSectionIdx = text.indexOf('\n\n## ', costIdx + 1)
    const section = text.slice(costIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)

    expect(section).toMatch(/never LaTeX/)
    expect(section).toContain('$\\rightarrow$')
  })
})

describe('platformAgent instructions — short-drama-stitch contract', () => {
  it('includes the short-drama-stitch contract with its no-generation mutual-exclusion clause', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    expect(text).toContain('Short-drama-stitch ad')
    expect(text).toContain('NOT when the user wants new footage created from scratch')
  })

  it('disambiguates short-drama-stitch from the three generation contracts BOTH ways', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    // Bidirectional: short-drama-stitch's own opening line names the other
    // three, AND each of the other three's opening line now names
    // short-drama-stitch back — a one-directional version would pass a
    // weaker assertion that only checked both section headers exist, which
    // proves nothing about whether either contract actually POINTS at the
    // other. This test asserts the actual disambiguating clause is present
    // on all three reciprocal sides, not just that both sections exist.
    // The Talking-head side of that reciprocal check now lives in the
    // Talking head Official skill's own text (moved out of these
    // instructions), so it's checked against TALKING_HEAD_SKILL_TEXT
    // instead of the composed instructions `text`.
    const ugcIdx = text.indexOf('## UGC character ad')
    const animIdx = text.indexOf('## Animation-character ad')
    const dramaIdx = text.indexOf('## Short-drama-stitch ad')
    expect(ugcIdx).toBeGreaterThan(-1)
    expect(animIdx).toBeGreaterThan(-1)
    expect(dramaIdx).toBeGreaterThan(-1)
    const reciprocalClause = 'Short-drama-stitch ad contract below instead'
    expect(text.slice(ugcIdx, ugcIdx + 800)).toContain(reciprocalClause)
    expect(TALKING_HEAD_SKILL_TEXT.slice(0, 800)).toContain(reciprocalClause)
    expect(text.slice(animIdx, animIdx + 800)).toContain(reciprocalClause)
  })

  it('widens ROUTING_CONTRACT to cover editing verbs, not just generation verbs', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    expect(text).toContain('stitch, cut, edit, or assemble existing footage into')
  })
})

describe('platformAgent instructions — UGC first-frame contract', () => {
  it('includes the UGC first-frame contract with its no-board-build clause', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    expect(text).toContain('## UGC first-frame ad')
    expect(text).toContain('no new character or storyboard being built from scratch')
  })

  it('disambiguates UGC first-frame from the UGC character contract both ways', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    const ugcIdx = text.indexOf('## UGC character ad')
    const firstFrameIdx = text.indexOf('## UGC first-frame ad')
    expect(ugcIdx).toBeGreaterThan(-1)
    expect(firstFrameIdx).toBeGreaterThan(-1)
    // UGC character's own trigger line must route an already-have-a-still
    // request to this contract, and this contract's own trigger line must
    // route a build-from-scratch request back — a one-directional check
    // would pass even if only one side actually cross-references the other.
    expect(text.slice(ugcIdx, ugcIdx + 800)).toContain('UGC first-frame ad contract')
    expect(text.slice(firstFrameIdx, firstFrameIdx + 500)).toContain('UGC character ad contract')
  })

  it('states the one-confirmation-per-clip cost note and the separate dialogue-approval rule', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    const firstFrameIdx = text.indexOf('## UGC first-frame ad')
    const nextSectionIdx = text.indexOf('\n\n## ', firstFrameIdx + 1)
    const section = text.slice(firstFrameIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)
    expect(section).toContain('one cost confirmation per clip')
    expect(section).toContain('separate from the cost approval')
  })

  it('disambiguates UGC first-frame from the Talking-head contract both ways (a photo of a presenter reading a script matches only one)', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    const firstFrameIdx = text.indexOf('## UGC first-frame ad')
    expect(firstFrameIdx).toBeGreaterThan(-1)
    // The Talking-head side of this reciprocal check now lives in the
    // Talking head Official skill's own text (moved out of these
    // instructions) rather than at some index within the composed `text` —
    // the ordering assertion that used to compare the two contracts'
    // positions in one concatenated string no longer applies now that they
    // live in separate documents, but both cross-reference clauses below
    // are unchanged, verbatim text.
    expect(TALKING_HEAD_SKILL_TEXT.slice(0, 800)).toContain('UGC first-frame ad contract')
    expect(text.slice(firstFrameIdx, firstFrameIdx + 700)).toContain('Talking-head ad contract')
    expect(text.slice(firstFrameIdx, firstFrameIdx + 700)).toContain('Talking-head ad contract below instead')
  })

  it('intake asks for aspect ratio and per-clip duration before any cost estimate', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    const firstFrameIdx = text.indexOf('## UGC first-frame ad')
    const nextSectionIdx = text.indexOf('\n\n## ', firstFrameIdx + 1)
    const section = text.slice(firstFrameIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)
    const intakeIdx = section.indexOf('1. Intake:')
    expect(intakeIdx).toBeGreaterThan(-1)
    expect(section.slice(intakeIdx, intakeIdx + 700)).toMatch(/aspect ratio/)
    expect(section.slice(intakeIdx, intakeIdx + 700)).toMatch(/duration/)
  })

  it('corrects the still-reuse path to the board-approval turn result, not the cast-sheet-only memory field', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    const firstFrameIdx = text.indexOf('## UGC first-frame ad')
    const nextSectionIdx = text.indexOf('\n\n## ', firstFrameIdx + 1)
    const section = text.slice(firstFrameIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)
    // The corrected guidance still names the memory field, but only to say a
    // per-beat still is NOT written there (only the cast sheet is) — a bare
    // "not.toContain" on the field name would fail this correct clarification
    // just as readily as it would catch the original bug, so assert the
    // actual corrective claim instead.
    expect(section).toContain("neither is a per-beat still")
    expect(section).toMatch(/board-approval turn/)
  })
})

describe('platformAgent instructions — working memory contract', () => {
  it('keeps one-task choices and invented preferences out of Brand Context and User Preferences', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    expect(text).toMatch(/Delegating to a sub-agent is always a tool call, never text/)
    expect(text).toContain('## Working memory — what goes where')
    expect(text).toMatch(/at most once per turn/)
    expect(text).toMatch(/Never fill it from one task's choices/)
    expect(text).toMatch(/Never infer one and never invent one/)
    expect(text).toMatch(/never option labels such as "\(Recommended\)"/)
  })
})
describe('picked library avatars keep their category\'s look', () => {
  it('routes an Animation avatar to the animated flow and keeps a TVC avatar polished', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    expect(text).toMatch(/"Avatar category: Animation"[^]*route to the Animation-character contract with that character as the identity reference/)
    expect(text).toMatch(/skip the style question and the cast-sheet generation/)
    expect(text).toMatch(/"avatar_cozy_3d_mascot", "avatar_game_hero", "avatar_cinematic_anime", "avatar_fantasy_anime", "avatar_3d_chibi" or "avatar_storybook_anime"/)
    expect(text).toMatch(/Never force it into the 3D, 2D flat or claymation styles/)
    expect(text).toMatch(/Exception: when the lead is a picked Animation avatar/)
    expect(text).toMatch(/"Avatar category: TVC"[^]*never the phone-selfie UGC look/)
  })

  it('asks which kind of avatar first when several avatar skills are on', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    expect(text).toMatch(/If more than one avatar skill .* is turned on and the user has not said which kind of avatar they want/)
    expect(text).toMatch(/What kind of avatar do you want\?/)
    expect(text).toMatch(/follow only the chosen skill/)
  })
})

describe('TVC ad routing', () => {
  it('offers a TV commercial in the ad-type question and routes TVC avatars to the TVC ad', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    // FLOW_SKILLS_TEXT is defined at the top of this test file (the skill bodies Olmo loads).
    const text = (typeof instructions === 'string' ? instructions : JSON.stringify(instructions)) + FLOW_SKILLS_TEXT
    expect(text).toMatch(/"TV commercial — polished shots, voiceover and a product ending"/)
    expect(text).toMatch(/"Avatar category: TVC"[^]*route it to the TVC ad skill/)
    // The shipped rules stay (additive change).
    expect(text).toMatch(/"Talking-head — one person talks to camera/)
    expect(text).toMatch(/"Avatar category: TVC"[^]*never the phone-selfie UGC look/)
  })

  it('a picked Voice ID is the TVC ad\'s announcer voice (additive line)', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toMatch(/picked "Voice ID:" is used by the TVC ad as its announcer voice/)
    expect(text).toMatch(/Route to a skill that calls generate_narration: Talking-head, Animation-character, or Template video cloning/)
  })
})


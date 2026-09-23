import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { platformAgent } from '../platformAgent.js'

describe('platformAgent instructions — talking-head contract', () => {
  it('composes the TALKING_HEAD_CONTRACT section into instructions', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    expect(text).toContain('## Talking-head ad — intake, narration lock, and delivery')
  })

  it('routes single-continuous-presenter requests away from the UGC character contract', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const ugcIdx = text.indexOf('## UGC character ad')
    expect(ugcIdx).toBeGreaterThanOrEqual(0)
    // The UGC contract's own trigger line must now explicitly route a
    // single-continuous-presenter request to the talking-head contract
    // instead, so the two contracts' trigger conditions don't overlap.
    const ugcTriggerLine = text.slice(ugcIdx, ugcIdx + 600)
    expect(ugcTriggerLine).toContain('Talking-head ad contract')
  })

  it('narration lock — the contract requires locking BOTH fileId and durationSeconds, and restating them on every later delegation', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const talkingHeadIdx = text.indexOf('## Talking-head ad')
    expect(talkingHeadIdx).toBeGreaterThanOrEqual(0)
    const section = text.slice(talkingHeadIdx, talkingHeadIdx + 2500)

    expect(section).toContain('Locked Reference Artifact IDs')
    expect(section).toContain('durationSeconds')
    expect(section).toMatch(/[Rr]estate this locked narration fileId and durationSeconds/)
    expect(section).toContain('Never re-delegate a fresh generate_narration call')
  })

  it('states the up-front multi-confirmation cost warning and the board gate', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const talkingHeadIdx = text.indexOf('## Talking-head ad')
    const nextSectionIdx = text.indexOf('\n\n## ', talkingHeadIdx + 1)
    const section = text.slice(talkingHeadIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)

    expect(section).toMatch(/8-10 separate cost confirmations/)
    expect(section).toMatch(/present them together and ask the user to approve the set as a whole/)
    expect(section).toMatch(/deliberate visible cut/)
  })
})

describe('platformAgent instructions — short-drama-stitch contract', () => {
  it('includes the short-drama-stitch contract with its no-generation mutual-exclusion clause', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('Short-drama-stitch ad')
    expect(text).toContain('NOT when the user wants new footage created from scratch')
  })

  it('disambiguates short-drama-stitch from the three generation contracts BOTH ways', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    // Bidirectional: short-drama-stitch's own opening line names the other
    // three, AND each of the other three's opening line now names
    // short-drama-stitch back — a one-directional version would pass a
    // weaker assertion that only checked both section headers exist, which
    // proves nothing about whether either contract actually POINTS at the
    // other. This test asserts the actual disambiguating clause is present
    // on all three reciprocal sides, not just that both sections exist.
    const ugcIdx = text.indexOf('## UGC character ad')
    const talkingHeadIdx = text.indexOf('## Talking-head ad')
    const animIdx = text.indexOf('## Animation-character ad')
    const dramaIdx = text.indexOf('## Short-drama-stitch ad')
    expect(ugcIdx).toBeGreaterThan(-1)
    expect(talkingHeadIdx).toBeGreaterThan(-1)
    expect(animIdx).toBeGreaterThan(-1)
    expect(dramaIdx).toBeGreaterThan(-1)
    const reciprocalClause = 'Short-drama-stitch ad contract below instead'
    expect(text.slice(ugcIdx, ugcIdx + 800)).toContain(reciprocalClause)
    expect(text.slice(talkingHeadIdx, talkingHeadIdx + 800)).toContain(reciprocalClause)
    expect(text.slice(animIdx, animIdx + 800)).toContain(reciprocalClause)
  })

  it('widens ROUTING_CONTRACT to cover editing verbs, not just generation verbs', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('stitch, cut, edit, or assemble existing footage into')
  })
})

describe('platformAgent instructions — UGC first-frame contract', () => {
  it('includes the UGC first-frame contract with its no-board-build clause', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('## UGC first-frame ad')
    expect(text).toContain('no new character or storyboard being built from scratch')
  })

  it('disambiguates UGC first-frame from the UGC character contract both ways', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
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
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const firstFrameIdx = text.indexOf('## UGC first-frame ad')
    const nextSectionIdx = text.indexOf('\n\n## ', firstFrameIdx + 1)
    const section = text.slice(firstFrameIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)
    expect(section).toContain('one cost confirmation per clip')
    expect(section).toContain('separate from the cost approval')
  })

  it('disambiguates UGC first-frame from the Talking-head contract both ways (a photo of a presenter reading a script matches only one)', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const talkingHeadIdx = text.indexOf('## Talking-head ad')
    const firstFrameIdx = text.indexOf('## UGC first-frame ad')
    expect(talkingHeadIdx).toBeGreaterThan(-1)
    expect(firstFrameIdx).toBeGreaterThan(-1)
    expect(text.slice(talkingHeadIdx, talkingHeadIdx + 800)).toContain('UGC first-frame ad contract')
    expect(text.slice(firstFrameIdx, firstFrameIdx + 700)).toContain('Talking-head ad contract')
    // Talking-head is composed AFTER first-frame in the concatenated string
    // (UGC_CHARACTER_CONTRACT + UGC_FIRST_FRAME_CONTRACT + TALKING_HEAD_CONTRACT),
    // so first-frame's own cross-reference must say "below", never "above" —
    // a caught regression: an earlier draft of this fix said "above".
    expect(firstFrameIdx).toBeLessThan(talkingHeadIdx)
    expect(text.slice(firstFrameIdx, firstFrameIdx + 700)).toContain('Talking-head ad contract below instead')
  })

  it('intake asks for aspect ratio and per-clip duration before any cost estimate', async () => {
    const requestContext = new RequestContext()
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
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
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
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

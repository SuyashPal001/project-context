import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { directorAgent, directorAgentDelegate } from '../directorAgent.js'

describe('directorAgent tool registration', () => {
  it('has analyze_video and analyze_audio registered, needed for template-video-generation', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(directorTools)).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
    expect(Object.keys(delegateTools)).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
  })

  it('has generate_narration, lipsync, and assemble_clips registered, needed for talking-head', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(directorTools)).toEqual(
      expect.arrayContaining(['generate_narration', 'lipsync', 'assemble_clips']),
    )
    expect(Object.keys(delegateTools)).toEqual(
      expect.arrayContaining(['generate_narration', 'lipsync', 'assemble_clips']),
    )
  })

  it('has mux_beat_audio, transcribe_audio, composite_end_card, burn_captions, mix_music_bed, and generate_song registered, needed for animation-character', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    // generate_song is included here even though it's not a new tool file —
    // it was never registered on directorAgent before this skill (only on
    // producerAgent), and animation-character's own flow has Director call
    // it directly for the music bed.
    const expected = ['mux_beat_audio', 'transcribe_audio', 'composite_end_card', 'burn_captions', 'mix_music_bed', 'generate_song', 'overlay_text', 'stretch_clip']
    expect(Object.keys(directorTools)).toEqual(expect.arrayContaining(expected))
    expect(Object.keys(delegateTools)).toEqual(expect.arrayContaining(expected))
  })
})

describe('directorAgent instructions', () => {
  it('appends template-cloning, UGC-character, and motion-craft sections even under a tenant agentSystemPrompt override', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Custom persona override text.')
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('Custom persona override text.')
    expect(text).toContain('## Template cloning')
    expect(text).toContain('## UGC character generation')
    expect(text).toContain('## Motion craft')
    expect(text).toContain('## Talking-head generation')
  })

  it('talking-head section never tells Director to read narration data from its own working memory, and covers the sub-3s clip floor / aspectRatio findings', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const talkingHeadStart = text.indexOf('## Talking-head generation')
    expect(talkingHeadStart).toBeGreaterThanOrEqual(0)
    const talkingHeadSection = text.slice(talkingHeadStart)

    // Regression guard for review finding 1: Director-as-delegate has no
    // memory of its own, so it cannot "read from working memory" — it must
    // rely on values restated in Olmo's delegation message.
    expect(talkingHeadSection).not.toContain('from working memory')
    expect(talkingHeadSection).toContain('Olmo gave you in this delegation message')

    // Finding 4: front-loading must never produce a sub-3-second clip.
    expect(talkingHeadSection).toContain('NEVER let any clip')
    expect(talkingHeadSection).toContain('below 3 seconds')

    // Finding 5: Assembly bullet must mention aspectRatio.
    const assemblyIdx = talkingHeadSection.indexOf('- Assembly:')
    expect(assemblyIdx).toBeGreaterThanOrEqual(0)
    expect(talkingHeadSection.slice(assemblyIdx, assemblyIdx + 400)).toContain('aspectRatio')

    // Finding 2: narration language passthrough.
    expect(talkingHeadSection).toContain('language')
  })
})

describe('directorAgent animation-character instructions', () => {
  it('appends the animation-character section with all three style-lock templates', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('## Animation-character generation')
    expect(text).toContain('STYLE "3d_pixar"')
    expect(text).toContain('STYLE "2d_flat"')
    expect(text).toContain('STYLE "claymation"')
  })

  it('never calls lipsync more than once and confines it to the hook beat', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## Animation-character generation')
    const section = text.slice(sectionStart)
    expect(section).toContain('This is the ONE beat in this ad that gets lip-sync')
  })

  it('places mix_music_bed after burn_captions in the section text (music bed is last, never before captions)', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## Animation-character generation')
    const section = text.slice(sectionStart)
    const captionsIdx = section.indexOf('Captions: call burn_captions')
    const musicIdx = section.indexOf('Music: call generate_song')
    expect(captionsIdx).toBeGreaterThanOrEqual(0)
    expect(musicIdx).toBeGreaterThan(captionsIdx)
  })
})

describe('directorAgent short-drama-stitch instructions', () => {
  it('registers trim_clip on both directorAgent and directorAgentDelegate', async () => {
    const agentTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(agentTools)).toEqual(expect.arrayContaining(['trim_clip']))
    expect(Object.keys(delegateTools)).toEqual(expect.arrayContaining(['trim_clip']))
  })

  it('includes the short-drama-stitch section with its no-generation rule', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('short-drama-stitch')
    expect(text).toContain('never calls generate_image or generate_video')
  })

  it('includes the exact brand-name-check substring for short-drama-stitch (no script to compare against)', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('this skill never generates speech, so there is no approved script to compare against')
  })

  it('orders captions before music in the short-drama-stitch section (pipeline-order regression guard)', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const shortDramaIdx = text.indexOf('Short-drama-stitch')
    const section = text.slice(shortDramaIdx)
    const captionsIdx = section.indexOf('Captions: call burn_captions')
    const musicIdx = section.indexOf('Music: call generate_song')
    expect(captionsIdx).toBeGreaterThan(-1)
    expect(musicIdx).toBeGreaterThan(captionsIdx)
  })
})

describe('directorAgent UGC first-frame instructions', () => {
  it('includes the UGC first-frame section with its no-cast-sheet rule', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('## UGC first-frame generation')
    expect(text).toContain('this skill never calls generate_image to create a presenter')
  })

  it('enforces the animate_frame / composite_references mutual exclusion in the section text', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## UGC first-frame generation')
    const section = text.slice(sectionStart)
    expect(section).toContain('mode "animate_frame"')
    expect(section).toContain('Never pass referenceFileIds alongside it')
  })

  it('issues one generate_video call at a time across multiple supplied stills', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## UGC first-frame generation')
    const section = text.slice(sectionStart)
    expect(section).toContain('one generate_video call at a time')
  })

  it('survives a tenant agentSystemPrompt override, same as the other appended sections', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Custom persona override text.')
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('Custom persona override text.')
    expect(text).toContain('## UGC first-frame generation')
  })

  it('places Motion craft before UGC first-frame generation, since the section references its rules by name', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const motionIdx = text.indexOf('## Motion craft')
    const firstFrameIdx = text.indexOf('## UGC first-frame generation')
    expect(motionIdx).toBeGreaterThanOrEqual(0)
    expect(firstFrameIdx).toBeGreaterThan(motionIdx)
  })

  it('requires aspectRatio and durationSeconds to be passed explicitly on every generate_video call', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## UGC first-frame generation')
    // Bounded to just this section — an unbounded slice would also match
    // ANIMATION_CHARACTER_SECTION further down the concatenated string
    // (which independently mentions both fields), letting this test pass
    // even if the fix here were deleted outright.
    const nextSectionIdx = text.indexOf('\n\n## ', sectionStart + 1)
    const section = text.slice(sectionStart, nextSectionIdx > 0 ? nextSectionIdx : undefined)
    expect(section).toContain('aspectRatio')
    expect(section).toContain('durationSeconds')
  })

  it('instructs setting approvedDialogue whenever a clip has spoken dialogue, never a quoted line left unset', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## UGC first-frame generation')
    const section = text.slice(sectionStart)
    expect(section).toContain('approvedDialogue')
    expect(section).toMatch(/never write a quoted line without setting approvedDialogue/)
  })
})

describe('directorAgent batch generation tools', () => {
  it('registers generate_videos and generate_images on both Director agents', async () => {
    for (const agent of [directorAgent, directorAgentDelegate]) {
      const tools = await agent.listTools()
      expect(Object.keys(tools)).toEqual(expect.arrayContaining(['generate_videos', 'generate_images']))
    }
  })

  it('tells Director to batch independent items and to keep dependent calls sequential', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Custom persona override text.')
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('generate_videos')
    expect(text).toContain('in ONE call')
    expect(text).toContain('Issue generation calls strictly one at a time')
    expect(text).toContain('priced for the whole batch')
    expect(text).toContain('each entry of the results list')
  })
})

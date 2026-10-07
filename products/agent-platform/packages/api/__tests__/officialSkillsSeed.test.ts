import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFICIAL_SKILLS, buildSkillManifest, manifestUnchanged, readSkillBody } from '../seeds/official-skills';

describe('OFFICIAL_SKILLS', () => {
  it('has every slug', () => {
    const slugs = OFFICIAL_SKILLS.map((s) => s.slug).sort();
    expect(slugs).toEqual(['animated-character-creator', 'animation-character-ad', 'short-drama-stitch', 'talking-head', 'template-video', 'tvc-ad', 'tvc-character-creator', 'ugc-avatar-creator', 'ugc-character-ad', 'ugc-first-frame']);
  });

  it('tvc-ad carries its card, Director marker and step rules', () => {
    const tvc = OFFICIAL_SKILLS.find((s) => s.slug === 'tvc-ad')!;
    expect(tvc.name).toBe('TVC ad');
    expect(tvc.director?.markers).toEqual(['flow: tvc ad']);
    expect(tvc.showcase.starterPrompt).toBe('Make a TV commercial for my product');
    expect(tvc.showcase.bestFor).toEqual(['TV-style ads', 'Product launches', 'Brand films']);
    const card = readFileSync(tvc.file, 'utf8');
    expect(card).toContain('"flow: tvc ad"');
    expect(card).toContain('TVC plan: <planFileId>');
    expect(card).toMatch(/Never call the ad legally compliant/);
    const director = readFileSync(tvc.director!.file, 'utf8');
    expect(director).toContain('plan_tvc');
    expect(director).toContain('mix_voiceover');
    expect(director).toContain('expectNoSpeech');
    expect(director).toMatch(/MISSING_AUDIO_STREAM/);
    expect(director).toMatch(/INVALID_TRIM_RANGE/);
    expect(director).toMatch(/at most 12 overlays/);
  });

  it('tvc-ad follows the final-review rulings', () => {
    const tvc = OFFICIAL_SKILLS.find((s) => s.slug === 'tvc-ad')!;
    const card = readFileSync(tvc.file, 'utf8');
    const director = readFileSync(tvc.director!.file, 'utf8');
    // Lengths and voice.
    expect(card).toMatch(/6 and 20 are also possible/);
    expect(card).not.toMatch(/30 are also possible/);
    expect(card).toMatch(/list_casting_assets with kind "voice"/);
    expect(card).toMatch(/"Voice ID: <id>" in the "step: plan" delegation/);
    expect(card).toMatch(/the avatar's file id/);
    expect(director).toMatch(/"Voice ID: <id>", write that id exactly into brief\.voiceId/);
    expect(director).toMatch(/voiceId exactly brief\.voiceId and targetSeconds = the block's words divided by 2\.7/);
    // One moment per delegation, keep = next moment, redo = redo shot; Auto mode.
    expect(card).toMatch(/Delegate one moment at a time/);
    expect(card).toMatch(/Keeping it means delegating the next moment \(Director has already saved it\); a redo is "step: redo shot <n>"/);
    expect(card).toMatch(/Auto mode: In Auto mode[^]*"auto: continue"/);
    expect(director).toMatch(/Make ONE moment per delegation/);
    expect(director).toMatch(/Auto mode \(supersedes[^]*"auto: continue"/);
    // A failed check is still trimmed and recorded; line shots re-checked after the trim.
    expect(director).toMatch(/Still trim and record that clip, then stop/);
    expect(director).toMatch(/check_clip the TRIMMED clip with expectedLine/);
    // The rules the check enforces, stills batches and references, one record call.
    expect(director).toMatch(/at most 8 shots/);
    expect(director).toMatch(/generate_images in batches of at most 4 shots/);
    expect(director).toMatch(/including product_macro, superpower and packshot stills and every shot of a mood ad/);
    expect(director).toMatch(/in one record call with records/);
    // Minor fixes.
    expect(director).toMatch(/noPerson true when no face is visible/);
    expect(director).not.toMatch(/"No one speaks\."/);
    expect(director).toMatch(/no voiceover blocks, skip generate_narration and mix_voiceover/);
    expect(director).toMatch(/reuse them; if not, generate_narration/);
    expect(director).toMatch(/songFileId, reuse it; if not, generate_song/);
    expect(director).toMatch(/position bottom, size small/);
    expect(director).toMatch(/position center, size large/);
    expect(director).toMatch(/position top, size medium/);
    // Quality tools pointers (additive section).
    expect(director).toMatch(/Quality tools \(supersede the matching lines above\)/)
    expect(director).toContain('check_still')
    expect(director).toContain('detect_cuts')
    // Task 4: cut times come from the reference file itself, never Director's own numbers.
    expect(director).toMatch(/Set brief\.reference\.videoFileId to the reference video \(this supersedes writing cutTimes above\): plan_tvc reads its cut times itself/)
    expect(director).toMatch(/generateSeconds/)
    expect(director).toMatch(/trimStartSeconds/)
    expect(director).toMatch(/productFileId/)
    // F1: trimFixed wins over check_clip's trimStartSeconds for a continuing/trimToEnd shot.
    expect(director).toMatch(/slice has trimFixed true, the slice's values win over check_clip's trimStartSeconds/)
    expect(director).toMatch(/do not pass shotDurationSeconds to check_clip/)
    // F3: productFileId only for a productAnchor shot, never for a continuing shot.
    expect(director).toMatch(/Pass productFileId to generate_video only for a shot whose slice has productAnchor true/)
    expect(director).toMatch(/Never pass it for a continuing shot/)
    expect(director).toMatch(/avoidFaces true/)
    expect(director).toMatch(/keptByUser/)
    expect(director).toMatch(/roomTone true/)
    expect(director).toMatch(/one direction and complete/)
    expect(card).toMatch(/Reference video: <fileId>/)
    // Part B: the sung sign-off (additive section).
    expect(director).toMatch(/Sung sign-off \(supersedes the Music line above when the finish slice has a jingle\)/)
    expect(director).toContain('generate_jingle')
    expect(director).toContain('kind "jingle"')
    expect(director).toContain('signoffStartSeconds')
    expect(director).toContain('fadeOutAtSeconds')
    expect(director).toContain('JINGLE_LINE_NOT_SUNG')
    // F1: plan-check-time refusal before any jingle generation money is spent.
    expect(director).toMatch(/When plan_tvc check returns JINGLE_WONT_FIT, move the voiceover earlier or shorten the sung line as it says, then check again, before making any jingle\./)
    expect(card).toContain('Jingle: <the line to sing>')
    expect(card).toMatch(/default is no jingle/)
    // Task 2: the product photo can never be a frame pulled from the reference or any other file.
    expect(director).toMatch(/If the brief has no product photo, never take one from the reference video or any other file; return to Olmo so it asks the user to upload a product photo\./)
    // Part 2.1: legal disclaimers (additive section).
    expect(director).toMatch(/Legal disclaimers \(supersede the legal parts of the lines above\)/)
    expect(director).toMatch(/forVoiceoverBlock = the number of the voiceover block that makes the claim/)
    expect(director).toMatch(/Never write endSeconds/)
    expect(director).toMatch(/brief\.brandName/)
    expect(director).toMatch(/run the steps in the finish slice's finishOrder; composite_end_card always comes before overlay_text/)
    expect(director).toMatch(/pass each of the finish slice's legal entries exactly as given \(text, startSeconds, endSeconds\) with size "legal"/)
    expect(director).toMatch(/Never shorten or move a disclaimer to make it fit/)
    expect(director).toMatch(/On LEGAL_TOO_LONG or LEGAL_HOLD_TOO_LONG, return the reason to Olmo/)
    expect(director).toContain('END_CARD_OVER_DISCLAIMER')
    expect(director).toMatch(/does not make a performance claim acceptable/)
    // The shipped lines are still there, word for word (append only).
    expect(director).toMatch(/position bottom, size small/)
    expect(card).toMatch(/17\. Disclaimers: when the ad makes a product claim/)
    expect(card).toMatch(/Disclaimer for '<the claim>': <text>/)
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc/)
    // F3: finishOrder supersedes the finish lines above (overlay_text runs last).
    expect(director).toMatch(/When the finish slice has finishOrder, follow it exactly; it supersedes the order of the finish lines above/)
    // F4: a 9:16 disclaimer must be kept short.
    expect(card).toMatch(/For a 9:16 ad keep a disclaimer to about 45 characters \(two short lines\); a 16:9 ad fits about twice that\./)
  });

  it('each entry file exists and is non-empty', () => {
    for (const entry of OFFICIAL_SKILLS) {
      expect(existsSync(entry.file)).toBe(true);
      const contents = readFileSync(entry.file, 'utf8');
      expect(contents.trim().length).toBeGreaterThan(0);
    }
  });

  it('ugc-avatar-creator.md contains the moved contract text', () => {
    const avatar = OFFICIAL_SKILLS.find((s) => s.slug === 'ugc-avatar-creator')!;
    const body = readFileSync(avatar.file, 'utf8');
    expect(body).toContain('Avatar creation');
    expect(body).toContain('ONE generate_images batch');
  });

  it('talking-head.md contains the moved contract text', () => {
    const talkingHead = OFFICIAL_SKILLS.find((s) => s.slug === 'talking-head')!;
    const body = readFileSync(talkingHead.file, 'utf8');
    expect(body).toContain('Talking-head ad');
  });

  it('carries the required showcase and description fields verbatim', () => {
    const avatar = OFFICIAL_SKILLS.find((s) => s.slug === 'ugc-avatar-creator')!;
    expect(avatar.name).toBe('UGC avatar creator');
    expect(avatar.description).toBe('Use when the user wants a new reusable AI presenter/avatar for their ads, from a description or from a reference photo.');
    expect(avatar.showcase).toEqual({
      imageUrl: '/creative/avatars/beginner-fitness-instructor.jpg',
      bestFor: ['UGC ads', 'Presenters', 'Brand faces'],
      starterPrompt: 'Create a new avatar for my ads',
    });

    const talkingHead = OFFICIAL_SKILLS.find((s) => s.slug === 'talking-head')!;
    expect(talkingHead.name).toBe('Talking head');
    expect(talkingHead.description).toBe('Use when the user wants a single presenter speaking one continuous script to camera — a talking-head ad.');
    expect(talkingHead.showcase).toEqual({
      imageUrl: '/creative/skills/talking-head-example.jpg',
      videoUrl: '/creative/skills/talking-head-example.mp4',
      bestFor: ['Product explainers', 'Testimonials', 'Announcements'],
      starterPrompt: 'Make a talking-head ad for my product',
    });
  });
});

describe('readSkillBody', () => {
  it('reads and trims a non-empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'official-skills-test-'));
    const file = join(dir, 'body.md');
    writeFileSync(file, '\n\n  ## Heading\nSome body text.\n\n');
    expect(readSkillBody(file)).toBe('## Heading\nSome body text.');
  });

  it('throws on an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'official-skills-test-'));
    const file = join(dir, 'empty.md');
    writeFileSync(file, '   \n\n  ');
    expect(() => readSkillBody(file)).toThrow();
  });

  it('throws when the file does not exist', () => {
    expect(() => readSkillBody('/nonexistent/path/does-not-exist.md')).toThrow();
  });
});

describe('buildSkillManifest', () => {
  it('builds { name, description, body }', () => {
    expect(buildSkillManifest('Avatar creator', 'Use when...', '## Body text')).toEqual({
      name: 'Avatar creator',
      description: 'Use when...',
      body: '## Body text',
    });
  });
});

describe('Director references', () => {
  it('TVC carries its Director rules as director.md, marked by "style: tvc"', () => {
    const tvc = OFFICIAL_SKILLS.find((s) => s.slug === 'tvc-character-creator')!;
    expect(tvc.director?.markers).toEqual(['style: tvc']);
    const text = readSkillBody(tvc.director!.file);
    expect(text.startsWith('## TVC character — a polished commercial lead actor, with a continuity bible')).toBe(true);
    // Olmo's brief must carry the marker, or Director never loads the rules.
    expect(readSkillBody(tvc.file)).toContain('"style: tvc"');
  });

  it('puts director.md and the marker into the manifest', () => {
    expect(buildSkillManifest('TVC', 'Use when...', 'body', { text: 'rules', markers: ['style: tvc'] })).toEqual({
      name: 'TVC',
      description: 'Use when...',
      body: 'body',
      references: { 'director.md': 'rules' },
      directorMarkers: ['style: tvc'],
    });
  });

  it('writes a new version when only director.md changes', () => {
    const before = buildSkillManifest('TVC', 'd', 'body', { text: 'rules v1', markers: ['style: tvc'] });
    const after = buildSkillManifest('TVC', 'd', 'body', { text: 'rules v2', markers: ['style: tvc'] });
    expect(manifestUnchanged(before, after)).toBe(false);
    expect(manifestUnchanged(before, before)).toBe(true);
    expect(manifestUnchanged({ name: 'TVC', description: 'd', body: 'body' }, after)).toBe(false);
    expect(manifestUnchanged({ name: 'A', description: 'd', body: 'body' }, buildSkillManifest('A', 'd', 'body'))).toBe(true);
  });

  it('gives Avatar creator and Animated their Director halves, with a marker for every animated style Olmo can send', () => {
    const avatar = OFFICIAL_SKILLS.find((s) => s.slug === 'ugc-avatar-creator')!;
    const animated = OFFICIAL_SKILLS.find((s) => s.slug === 'animated-character-creator')!;
    expect(avatar.director?.markers).toEqual(['style: realistic avatar']);
    expect(readSkillBody(avatar.director!.file)).toContain('roll_avatar_variations once');
    const animatedSkill = readSkillBody(animated.file);
    const sent = [...animatedSkill.matchAll(/"(style: [a-z0-9 ]+)"/g)].map((m) => m[1]);
    expect(sent.length).toBeGreaterThan(0);
    for (const marker of sent) expect(animated.director!.markers).toContain(marker);
    const rules = readSkillBody(animated.director!.file);
    for (const marker of animated.director!.markers) expect(rules).toContain(marker);
  });

  it('gives Talking head its Director half, and has Olmo send "flow: talking head" on every call', () => {
    const talkingHead = OFFICIAL_SKILLS.find((s) => s.slug === 'talking-head')!;
    expect(talkingHead.director?.markers).toEqual(['flow: talking head']);
    expect(readSkillBody(talkingHead.director!.file).startsWith('## Talking-head generation')).toBe(true);
    expect(readSkillBody(talkingHead.file)).toContain('includes the line "flow: talking head"');
  });

  it('gives UGC character ad its Director half: checked clips joined into one video', () => {
    const ugc = OFFICIAL_SKILLS.find((s) => s.slug === 'ugc-character-ad')!;
    expect(ugc.director?.markers).toEqual(['flow: ugc ad']);
    const rules = readSkillBody(ugc.director!.file);
    expect(rules).toContain('check_clip');
    expect(rules).toContain('preserveAudio true');
    expect(rules).toContain('approvedDialogue');
    const body = readSkillBody(ugc.file);
    expect(body).toContain('includes the line "flow: ugc ad"');
    expect(body).toContain('ONE finished video');
    expect(body).not.toContain('not assembled into one final ad');
    expect(body).not.toContain('exists only in this conversation');
  });

  it('every Official skill has a Director half, except the two whose Director rules other flows share', () => {
    // UGC character generation and Template cloning stay in Director's base
    // instructions: the avatar creators, TVC and Talking head lean on them
    // (batch rules, the cast sheet, the transcript QA).
    for (const entry of OFFICIAL_SKILLS) {
      if (entry.slug === 'template-video') expect(entry.director, entry.slug).toBeUndefined();
      else expect(entry.director, entry.slug).toBeDefined();
    }
  });

  it('has each flow with a Director half tell Olmo to send its marker on every call', () => {
    for (const entry of OFFICIAL_SKILLS) {
      if (!entry.director || !entry.director.markers[0].startsWith('flow:')) continue;
      expect(readSkillBody(entry.file), entry.slug).toContain(`includes the line "${entry.director.markers[0]}"`);
    }
  });
});

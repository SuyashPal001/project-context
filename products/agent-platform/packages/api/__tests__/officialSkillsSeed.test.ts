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
    // Part 2.2: logo, veg mark, text motion and prices (additive section).
    expect(director).toMatch(/Logo, veg mark, text motion and prices \(supersede the matching lines above\)/)
    expect(director).toMatch(/write brief\.logoFileId from Olmo's "Logo: <fileId>"/)
    expect(director).toMatch(/brief\.vegMark \("veg" or "non_veg"\)/)
    expect(director).toMatch(/never in its text; that shot must be at least 1\.2 seconds/)
    expect(director).toMatch(/when the finish slice has endCard, pass its logoFileId, vegMark and disclaimerLines exactly as given/)
    expect(director).toMatch(/pass each shot's motion exactly as the finish slice gives it/)
    expect(director).toContain('LOGO_NOT_RASTER')
    expect(director).toContain('PRICE_TOO_SHORT')
    expect(card).toMatch(/18\. Logo, veg mark and prices \(supersedes the veg-mark part of item 8\)/)
    expect(card).toMatch(/"Logo: <fileId>"/)
    expect(card).toMatch(/"Veg mark: veg" or "Veg mark: non-veg"/)
    expect(card).toMatch(/"Price: <amount>; MRP: <higher price>; note: <short line>"/)
    // The shipped lines are still there, word for word (append only).
    expect(card).toMatch(/or the veg mark cannot be added yet/)
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc|composite_end_card/)
    // F1: packshot overlays sit at center with a logo, so they never cover it.
    expect(director).toMatch(/When the finish slice gives an overlay a position, use it exactly \(with a logo, packshot text and prices sit at center so they never cover the logo\)\./)
    // F4: a plain-words script for every logo refusal, including the one new on this branch.
    expect(director).toMatch(/LOGO_IS_PRODUCT_PHOTO, LOGO_NOT_RASTER, LOGO_NOT_IMAGE, LOGO_UNCHECKED or LOGO_FROM_REFERENCE/)
    expect(card).toMatch(/that image came from the reference ad, not your brand; please upload your own logo/)
    expect(card).toMatch(/I couldn't read the logo; please try uploading it again/)
    // F5: the logo accepts PNG, JPG or WebP everywhere the card says so.
    expect(card).toMatch(/PNG, JPG or WebP\? A see-through PNG looks best/)
    expect(card).toMatch(/ask for a PNG, JPG or WebP logo in one plain sentence/)
    expect(card).not.toMatch(/PNG or JPG/)
  });

  it('tvc-ad offers 30 seconds and joins it in two stages (Part 2.3, append only)', () => {
    const tvc = OFFICIAL_SKILLS.find((s) => s.slug === 'tvc-ad')!;
    const card = readFileSync(tvc.file, 'utf8');
    const director = readFileSync(tvc.director!.file, 'utf8');
    expect(director).toMatch(/30-second ads and the two-stage join \(supersede the matching lines above\):/);
    expect(director).toMatch(/the length may also be 30 seconds: up to 20 shots, a word cap of 45 across voiceover and lines/);
    expect(director).toMatch(/On JOIN_SPLIT_IMPOSSIBLE, remove continuesFrom from one continuing shot in the middle of the ad and check again\. On REFERENCE_TOO_MANY_CUTS, return the reason to Olmo in plain words\./);
    expect(director).toMatch(/when the finish slice has joinGroups, join each group with assemble_clips in order/);
    expect(director).toMatch(/preserveAudio true, roomTone true, the plan's aspect ratio/);
    expect(director).toMatch(/Then join the two results with assemble_clips: just those two videos in order, preserveAudio true, roomTone false \(each half already carries its room tone\), no transitions/);
    expect(director).toMatch(/"assemble_clips group 1", "assemble_clips group 2" and "assemble_clips final" in finishOrder are these three joins/);
    expect(director).toMatch(/If any of the three joins refuses with DURATION_MISMATCH \(it was refunded\), return the reason to Olmo, saying which join failed and the fileIds of the halves already joined/);
    // I2: the final join (not either half) is the finished ad.
    expect(director).toMatch(/When the finish slice has joinGroups, the finished ad is the result of the "assemble_clips final" step \(the join of both halves\), never group 1 or group 2 alone; use that video for every later step\./);
    expect(card).toMatch(/20\. 30-second ads \(supersedes the length list in item 1\): 30 seconds is also offered/);
    expect(card).toMatch(/costs about twice a 15-second one/);
    // The shipped lines are still there, word for word (append only).
    expect(director).toMatch(/assemble_clips once with every recorded clip in shot order \(the carded packshot last\), preserveAudio true, the plan's aspect ratio\./);
    expect(director).toMatch(/step finish: assemble_clips with roomTone true\./);
    expect(card).toMatch(/6 and 20 are also possible/);
    expect(card).not.toMatch(/30 are also possible/);
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc|composite_end_card|assemble_clips/);
  });

  it('tvc-ad makes cutdowns from the same footage (Part 2.4, append only)', () => {
    const tvc = OFFICIAL_SKILLS.find((s) => s.slug === 'tvc-ad')!;
    const card = readFileSync(tvc.file, 'utf8');
    const director = readFileSync(tvc.director!.file, 'utf8');
    expect(director).toMatch(/Cutdowns \(step: cutdown <length>; supersede the matching lines above for a cutdown\):/);
    expect(director).toMatch(/call plan_tvc with action "cutdown", planFileId = the TVC plan in the brief and lengthSeconds = the length asked for/);
    expect(director).toMatch(/Never change a shot's picture, source or clip/);
    expect(director).toMatch(/Narration is reused only when the whole voiceover is kept word for word from the original's blocks/);
    expect(director).toMatch(/when it has none, set startSeconds = the new start of the shot that shows the claim/);
    expect(director).toMatch(/When the cutdown result has editing \(a shorter version changed at its own length\), edit only its voiceover, legal lines, texts and tagline, and call plan_tvc check with planFileId = that editing id/);
    expect(director).toMatch(/On CUTDOWN_REDO_ON_ORIGINAL, make no new still or video: return it to Olmo/);
    expect(director).toMatch(/tie every legal line to the new voiceover block that makes its claim \(forVoiceoverBlock\), or give it wholeAd true; remove a legal line only when its claim is no longer said or shown/);
    expect(director).toMatch(/call plan_tvc check with the edited draft, keeping cutdownOf and every shot's source exactly as given, and without planFileId/);
    expect(director).toMatch(/On JINGLE_WONT_FIT in a cutdown, remove brief\.jingle and check again/);
    expect(director).toMatch(/when the finish slice has retrims, trim_clip each one \(sourceFileId = its sourceClipFileId, startSeconds, endSeconds\), plan_tvc record those clips in one call \(records, shot = each retrim's n\), then get the finish slice again and continue/);
    expect(director).toMatch(/When the finish slice has musicFadeOutAtSeconds, pass it to mix_music_bed as fadeOutAtSeconds/);
    expect(director).toMatch(/On a CUTDOWN_ refusal, return the reason to Olmo in plain words/);
    expect(card).toMatch(/21\. Shorter versions \(supersedes the step list in the line beginning "Every agent-director call" for this case\):/);
    expect(card).toMatch(/after delivering a finished original ad of 15 seconds or more/);
    expect(card).toMatch(/with the original ad's "TVC plan: <planFileId>" line/);
    expect(card).toMatch(/22\. Changing a shorter version \(supersedes item 7 for a shorter version\):/);
    expect(card).toMatch(/Never send "step: redo shot" or "step: redo still" with a shorter version's id\./);
    expect(card).toMatch(/made from the same footage, so it costs little/);
    expect(card).toMatch(/"step: cutdown <length>"/);
    expect(card).toMatch(/then delegate "step: finish" with the NEW TVC plan id/);
    // The shipped lines are still there, word for word (append only).
    expect(director).toMatch(/When the finish slice has joinGroups, the finished ad is the result of the "assemble_clips final" step/);
    expect(card).toMatch(/20\. 30-second ads \(supersedes the length list in item 1\): 30 seconds is also offered/);
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc|composite_end_card|assemble_clips|trim_clip/);
  });

  it('tvc-ad shows a rough cut before the clips (Part 2.5, append only)', () => {
    const tvc = OFFICIAL_SKILLS.find((s) => s.slug === 'tvc-ad')!;
    const card = readFileSync(tvc.file, 'utf8');
    const director = readFileSync(tvc.director!.file, 'utf8');
    expect(director).toMatch(/Rough cut \(step: animatic; supersedes the matching finish lines above for this step\):/);
    expect(director).toMatch(/plan_tvc get "animatic", then make only what its animaticOrder lists/);
    expect(director).toMatch(/narrate every voiceover block in one go: the rough cut is the user's first listen/);
    expect(director).toMatch(/record all of it in one plan_tvc record call, then call render_animatic with the planFileId and reply with its fileId only/);
    expect(director).toMatch(/step: animatic change: <what>: make the change in the plan, plan_tvc check with the same planFileId/);
    expect(director).toMatch(/pass on any NARRATION_REMAKE, MUSIC_REMAKE or JINGLE_REMAKE warning to Olmo/);
    expect(director).toMatch(/On an ANIMATIC_ refusal, make what it says is missing, or return the reason to Olmo in plain words/);
    expect(card).toMatch(/23\. Rough cut \(Ask mode; supersedes item 16 and the step list in the line beginning "Every agent-director call" for this case\):/);
    expect(card).toMatch(/delegate "step: animatic" with the TVC plan id/);
    expect(card).toMatch(/rough cut: still images with the real voiceover and music; the final has real motion and on-camera speech/);
    expect(card).toMatch(/Looks right, or what to change\?/);
    expect(card).toMatch(/"step: animatic change: <the change>"/);
    expect(card).toMatch(/never show the cost again or ask to approve it/);
    expect(card).toMatch(/In Auto mode skip the rough cut/);
    // The shipped lines are still there, word for word (append only).
    expect(card).toMatch(/22\. Changing a shorter version \(supersedes item 7 for a shorter version\):/);
    expect(director).toMatch(/On a CUTDOWN_ refusal, return the reason to Olmo in plain words/);
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc|composite_end_card|assemble_clips|trim_clip|render_animatic/);
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

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFICIAL_SKILLS, buildSkillManifest, readSkillBody } from '../seeds/official-skills';

describe('OFFICIAL_SKILLS', () => {
  it('has every slug', () => {
    const slugs = OFFICIAL_SKILLS.map((s) => s.slug).sort();
    expect(slugs).toEqual(['animated-character-creator', 'avatar-creator', 'talking-head', 'tvc-character-creator']);
  });

  it('each entry file exists and is non-empty', () => {
    for (const entry of OFFICIAL_SKILLS) {
      expect(existsSync(entry.file)).toBe(true);
      const contents = readFileSync(entry.file, 'utf8');
      expect(contents.trim().length).toBeGreaterThan(0);
    }
  });

  it('avatar-creator.md contains the moved contract text', () => {
    const avatar = OFFICIAL_SKILLS.find((s) => s.slug === 'avatar-creator')!;
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
    const avatar = OFFICIAL_SKILLS.find((s) => s.slug === 'avatar-creator')!;
    expect(avatar.name).toBe('Avatar creator');
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
      imageUrl: '/creative/avatars/beauty-skincare-presenter.jpg',
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

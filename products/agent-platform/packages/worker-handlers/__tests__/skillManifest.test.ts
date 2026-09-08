import { describe, it, expect } from 'vitest';
import { parseSkillManifest, SkillManifestError } from '../lib/skillManifest';

describe('parseSkillManifest', () => {
  it('parses name/description plus arbitrary extra fields', () => {
    const md = `---\nname: pdf-tools\ndescription: Extracts tables from PDFs\ntags:\n  - pdf\n  - extraction\n---\n\n# Body\n`;
    const manifest = parseSkillManifest(md);
    expect(manifest.name).toBe('pdf-tools');
    expect(manifest.description).toBe('Extracts tables from PDFs');
    expect(manifest.tags).toEqual(['pdf', 'extraction']);
  });

  it('rejects content with no frontmatter block', () => {
    expect(() => parseSkillManifest('# just a heading')).toThrow(SkillManifestError);
  });

  it('rejects frontmatter missing name', () => {
    const md = `---\ndescription: no name here\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/name/);
  });

  it('rejects frontmatter missing description', () => {
    const md = `---\nname: no-description\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/description/);
  });

  it('rejects invalid YAML', () => {
    const md = `---\nname: [unclosed\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(SkillManifestError);
  });

  it('rejects a description that is present but too short to be useful', () => {
    const md = `---\nname: too-thin\ndescription: a skill\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/too short/i);
  });

  it('rejects a description exactly one character under the floor', () => {
    // 19 characters — one under the 20-character floor this task introduces.
    const md = `---\nname: one-under\ndescription: "0123456789012345678"\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/too short/i);
  });

  it('accepts a description right at the minimum length', () => {
    // Exactly 20 characters — the floor this task introduces.
    const md = `---\nname: right-at-floor\ndescription: "01234567890123456789"\n---\nbody`;
    const manifest = parseSkillManifest(md);
    expect(manifest.description).toBe('01234567890123456789');
  });

  it('still distinguishes a missing description from a too-short one', () => {
    const md = `---\nname: no-description\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/missing required field/i);
  });
});

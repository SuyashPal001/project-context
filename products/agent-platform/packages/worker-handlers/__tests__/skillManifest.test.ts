import { describe, it, expect } from 'vitest';
import { parseSkillManifest, SkillManifestError } from '../lib/skillManifest';

describe('parseSkillManifest', () => {
  it('parses name/description plus arbitrary extra fields', () => {
    const md = `---\nname: pdf-tools\ndescription: Use when extracting tables from PDFs\ntags:\n  - pdf\n  - extraction\n---\n\n# Body\n`;
    const manifest = parseSkillManifest(md);
    expect(manifest.name).toBe('pdf-tools');
    expect(manifest.description).toBe('Use when extracting tables from PDFs');
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
    // Exactly 20 characters — the floor this task introduces — and contains
    // "when" so it also clears the when-check below.
    const md = `---\nname: right-at-floor\ndescription: "use when it applies!"\n---\nbody`;
    const manifest = parseSkillManifest(md);
    expect(manifest.description).toBe('use when it applies!');
  });

  it('still distinguishes a missing description from a too-short one', () => {
    const md = `---\nname: no-description\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/missing required field/i);
  });

  // Long enough to pass the length floor but summarizes what the skill does
  // rather than when to use it — the length check alone would let this through.
  it('rejects a description that is long enough but never says "when"', () => {
    const md = `---\nname: pdf-tools\ndescription: Extracts tables from PDF documents\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/should say when to use/i);
  });
});

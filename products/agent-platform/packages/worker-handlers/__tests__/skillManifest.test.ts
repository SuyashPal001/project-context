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
});

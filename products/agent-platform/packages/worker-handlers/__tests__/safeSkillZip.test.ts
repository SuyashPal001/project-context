import { describe, it, expect } from 'vitest';
import yazl from 'yazl';
import { pack } from 'tar-stream';
import { gzipSync } from 'zlib';
import { safeExtractSkillZip, safeExtractSkillTarball, SkillPackageError } from '../lib/safeSkillZip';

function buildZip(entries: { name: string; content: Buffer | string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
      zip.addBuffer(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content), entry.name);
    }
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.end();
  });
}

describe('safeExtractSkillZip', () => {
  it('accepts a valid package and returns the manifest source', async () => {
    const zip = await buildZip([
      { name: 'SKILL.md', content: '---\nname: demo\ndescription: A demo skill\n---\nbody' },
      { name: 'config.json', content: '{"ok":true}' },
    ]);
    const result = await safeExtractSkillZip(zip);
    expect(result.manifestSource).toContain('name: demo');
    expect(result.accepted.map((e) => e.fileName).sort()).toEqual(['SKILL.md', 'config.json']);
    expect(result.skipped).toEqual([]);
  });

  it('strips a single common wrapping folder before looking for SKILL.md', async () => {
    const zip = await buildZip([
      { name: 'my-skill/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
      { name: 'my-skill/lib/util.js', content: 'module.exports = {}' },
    ]);
    const result = await safeExtractSkillZip(zip);
    expect(result.accepted.map((e) => e.fileName).sort()).toEqual(['SKILL.md', 'lib/util.js']);
  });

  it('rejects an archive with no SKILL.md', async () => {
    const zip = await buildZip([{ name: 'readme.txt', content: 'hi' }]);
    await expect(safeExtractSkillZip(zip)).rejects.toThrow(/SKILL\.md/);
  });

  it('rejects entries with embedded null bytes', async () => {
    // Build a normal zip first, then inject null byte into the central directory filename
    const normalZip = await buildZip([
      { name: 'SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
      { name: 'safe/path.txt', content: 'x' },
    ]);

    // Replace all occurrences of 'safe/path.txt' with 'safe/path\0txt' (replacing '.' with null)
    const searchString = Buffer.from('safe/path.txt', 'utf-8');
    const replaceString = Buffer.from('safe/path\0txt', 'utf-8');

    let modifiedZip = normalZip;
    let idx = -1;
    while ((idx = modifiedZip.indexOf(searchString, idx + 1)) !== -1) {
      const before = modifiedZip.subarray(0, idx);
      const after = modifiedZip.subarray(idx + searchString.length);
      modifiedZip = Buffer.concat([before, replaceString, after]);
    }

    await expect(safeExtractSkillZip(modifiedZip)).rejects.toThrow(SkillPackageError);
  });

  it('skips unsupported extensions without rejecting the whole archive', async () => {
    const zip = await buildZip([
      { name: 'SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
      { name: 'photo.png', content: Buffer.from([0, 1, 2]) },
    ]);
    const result = await safeExtractSkillZip(zip);
    expect(result.skipped).toEqual([{ fileName: 'photo.png', reason: 'unsupported file type ".png"' }]);
  });
});

function buildTarball(entries: { name: string; content: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = pack();
    for (const entry of entries) p.entry({ name: entry.name }, entry.content);
    p.finalize();
    const chunks: Buffer[] = [];
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    p.on('error', reject);
  });
}

describe('safeExtractSkillTarball', () => {
  it('strips the GitHub codeload {repo}-{ref}/ wrapper and finds SKILL.md', async () => {
    const tarball = await buildTarball([
      { name: 'my-repo-main/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
      { name: 'my-repo-main/scripts/run.sh', content: '#!/bin/sh\necho hi' },
    ]);
    const result = await safeExtractSkillTarball(tarball);
    expect(result.accepted.map((e) => e.fileName).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
  });

  it('rejects a tarball with no SKILL.md', async () => {
    const tarball = await buildTarball([{ name: 'repo-main/readme.txt', content: 'hi' }]);
    await expect(safeExtractSkillTarball(tarball)).rejects.toThrow(/SKILL\.md/);
  });

  it('rejects path traversal in a tar entry name', async () => {
    const tarball = await buildTarball([{ name: '../../etc/passwd', content: 'x' }]);
    await expect(safeExtractSkillTarball(tarball)).rejects.toThrow(/unsafe entry path/);
  });

  it('rejects a buffer that is not valid gzip', async () => {
    await expect(safeExtractSkillTarball(Buffer.from('not gzip'))).rejects.toThrow(/gzip/);
  });
});

import { describe, it, expect } from 'vitest';
import yazl from 'yazl';
import { safeExtractSkillZip, SkillPackageError } from '../lib/safeSkillZip';

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

// Create a minimal ZIP file with path traversal entry by constructing bytes directly
function buildMaliciousZip(name: string, content: Buffer | string): Buffer {
  const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const nameBuffer = Buffer.from(name, 'utf-8');

  // Local file header signature
  const localFileHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  const versionNeeded = Buffer.from([0x14, 0x00]); // version 2.0
  const generalPurpose = Buffer.from([0x00, 0x00]); // no flags
  const compressionMethod = Buffer.from([0x00, 0x00]); // stored (no compression)
  const modTime = Buffer.from([0x21, 0x00, 0x00, 0x00]); // DOS time
  const crc32 = Buffer.alloc(4);
  let crc = 0xffffffff;
  for (let i = 0; i < contentBuffer.length; i++) {
    crc = (crc >>> 8) ^ ((crc ^ contentBuffer[i]) & 0xff);
  }
  crc = (crc ^ 0xffffffff) >>> 0; // Ensure unsigned 32-bit
  crc32.writeUInt32LE(crc, 0);

  const compressedSize = Buffer.alloc(4);
  compressedSize.writeUInt32LE(contentBuffer.length, 0);
  const uncompressedSize = Buffer.alloc(4);
  uncompressedSize.writeUInt32LE(contentBuffer.length, 0);
  const nameLen = Buffer.alloc(2);
  nameLen.writeUInt16LE(nameBuffer.length, 0);
  const extraLen = Buffer.from([0x00, 0x00]);

  // Local file header
  const localHeader = Buffer.concat([
    localFileHeader,
    versionNeeded,
    generalPurpose,
    compressionMethod,
    modTime,
    crc32,
    compressedSize,
    uncompressedSize,
    nameLen,
    extraLen,
    nameBuffer,
    contentBuffer,
  ]);

  // Central directory header
  const cdHeader = Buffer.from([0x50, 0x4b, 0x01, 0x02]); // PK\x01\x02
  const versionMade = Buffer.from([0x14, 0x00]);
  const cdVersionNeeded = versionNeeded;
  const cdGeneralPurpose = generalPurpose;
  const cdCompressionMethod = compressionMethod;
  const cdModTime = modTime;
  const cdCrc32 = crc32;
  const cdCompressedSize = compressedSize;
  const cdUncompressedSize = uncompressedSize;
  const cdNameLen = nameLen;
  const cdExtraLen = Buffer.from([0x00, 0x00]);
  const cdCommentLen = Buffer.from([0x00, 0x00]);
  const cdDiskNum = Buffer.from([0x00, 0x00]);
  const cdInternalAttr = Buffer.from([0x00, 0x00]);
  const cdExternalAttr = Buffer.alloc(4);
  const cdOffset = Buffer.alloc(4);
  cdOffset.writeUInt32LE(0, 0);

  const centralHeader = Buffer.concat([
    cdHeader,
    versionMade,
    cdVersionNeeded,
    cdGeneralPurpose,
    cdCompressionMethod,
    cdModTime,
    cdCrc32,
    cdCompressedSize,
    cdUncompressedSize,
    cdNameLen,
    cdExtraLen,
    cdCommentLen,
    cdDiskNum,
    cdInternalAttr,
    cdExternalAttr,
    cdOffset,
    nameBuffer,
  ]);

  // End of central directory record
  const eocdRecord = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // PK\x05\x06
  const eocdDisk = Buffer.from([0x00, 0x00]);
  const eocdStartDisk = Buffer.from([0x00, 0x00]);
  const eocdEntriesOnDisk = Buffer.from([0x01, 0x00]);
  const eocdEntries = Buffer.from([0x01, 0x00]);
  const eocdSize = Buffer.alloc(4);
  eocdSize.writeUInt32LE(centralHeader.length, 0);
  const eocdOffset = Buffer.alloc(4);
  eocdOffset.writeUInt32LE(localHeader.length, 0);
  const eocdCommentLen = Buffer.from([0x00, 0x00]);

  const eocd = Buffer.concat([
    eocdRecord,
    eocdDisk,
    eocdStartDisk,
    eocdEntriesOnDisk,
    eocdEntries,
    eocdSize,
    eocdOffset,
    eocdCommentLen,
  ]);

  return Buffer.concat([localHeader, centralHeader, eocd]);
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

  it('rejects zip-slip path traversal', async () => {
    const zip = buildMaliciousZip('../../etc/passwd', 'x');
    await expect(safeExtractSkillZip(zip)).rejects.toThrow(SkillPackageError);
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

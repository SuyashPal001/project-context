import yauzl from 'yauzl';
import { gunzipSync } from 'zlib';
import * as tarStream from 'tar-stream';

// Same defense-in-depth shape as ../lib/safeZip.ts (entry count/size/ratio
// caps + zip-slip rejection) but a different extension allowlist — skill
// packages carry manifests/config/code, not PDFs/DOCX — and an additional
// requirement that a SKILL.md manifest exists at the archive root. Written
// as a sibling file rather than parameterizing safeZip.ts, since that file
// runs on RAG document uploads with a different risk profile.
const MAX_ENTRIES = 500;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB per archive
const MAX_COMPRESSION_RATIO = 100;
const SUPPORTED_EXTENSIONS = ['.md', '.json', '.yaml', '.yml', '.txt', '.js', '.ts', '.py', '.sh', '.css', '.html', '.csv'];

export class SkillPackageError extends Error {}

export interface SafeSkillEntry {
  fileName: string;
  buffer: Buffer;
}

export interface SafeSkillPackageResult {
  accepted: SafeSkillEntry[];
  skipped: { fileName: string; reason: string }[];
  manifestSource: string;
}

// If every entry shares the same first path segment (e.g. a zip of a folder,
// or a GitHub tarball's `{repo}-{ref}/` wrapper), strip it so "SKILL.md at
// the archive root" means the same thing regardless of how the archive was
// built.
function stripCommonRoot(entries: SafeSkillEntry[]): SafeSkillEntry[] {
  if (entries.length === 0) return entries;
  const firstSegments = entries.map((e) => e.fileName.split('/')[0]);
  const [first] = firstSegments;
  const allHaveSlash = entries.every((e) => e.fileName.includes('/'));
  const allShareFirst = first && firstSegments.every((seg) => seg === first);
  if (!allHaveSlash || !allShareFirst) return entries;
  const prefix = `${first}/`;
  return entries.map((e) => ({ ...e, fileName: e.fileName.slice(prefix.length) }));
}

function findManifest(entries: SafeSkillEntry[]): { entries: SafeSkillEntry[]; manifestSource: string } {
  const normalized = stripCommonRoot(entries);
  const manifestEntry = normalized.find((e) => e.fileName === 'SKILL.md');
  if (!manifestEntry) {
    throw new SkillPackageError('Archive is missing a SKILL.md manifest at its root');
  }
  return { entries: normalized, manifestSource: manifestEntry.buffer.toString('utf-8') };
}

export function safeExtractSkillZip(zipBuffer: Buffer): Promise<SafeSkillPackageResult> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(new SkillPackageError(`Not a valid zip archive: ${openErr?.message ?? 'unknown error'}`));
        return;
      }

      const accepted: SafeSkillEntry[] = [];
      const skipped: { fileName: string; reason: string }[] = [];
      let entryCount = 0;
      let totalUncompressed = 0;
      let settled = false;

      const abort = (reason: string) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(new SkillPackageError(reason));
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          const { entries, manifestSource } = findManifest(accepted);
          resolve({ accepted: entries, skipped, manifestSource });
        } catch (err) {
          reject(err);
        }
      };

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        if (settled) return;

        entryCount++;
        if (entryCount > MAX_ENTRIES) {
          abort(`Archive has more than ${MAX_ENTRIES} entries — rejected`);
          return;
        }

        const fileName = entry.fileName;

        if (/[/\\]$/.test(fileName)) {
          zipfile.readEntry();
          return;
        }

        if (fileName.startsWith('/') || fileName.includes('..') || fileName.includes('\0')) {
          abort(`Archive contains an unsafe entry path: ${fileName}`);
          return;
        }

        if (fileName.toLowerCase().endsWith('.zip')) {
          skipped.push({ fileName, reason: 'nested archive not supported' });
          zipfile.readEntry();
          return;
        }

        const uncompressedSize = entry.uncompressedSize;
        const compressedSize = entry.compressedSize;

        if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
          skipped.push({ fileName, reason: `entry exceeds ${MAX_ENTRY_UNCOMPRESSED_BYTES}-byte limit` });
          zipfile.readEntry();
          return;
        }

        if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
          abort(`Entry "${fileName}" has a compression ratio over ${MAX_COMPRESSION_RATIO}:1 — rejected as a likely zip bomb`);
          return;
        }

        totalUncompressed += uncompressedSize;
        if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          abort(`Archive exceeds the total uncompressed size limit of ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`);
          return;
        }

        const dot = fileName.lastIndexOf('.');
        const ext = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.includes(ext)) {
          skipped.push({ fileName, reason: `unsupported file type "${ext || '(none)'}"` });
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (settled) return;
          if (streamErr || !readStream) {
            skipped.push({ fileName, reason: 'could not open entry stream' });
            zipfile.readEntry();
            return;
          }

          const chunks: Buffer[] = [];
          let readBytes = 0;

          readStream.on('data', (chunk: Buffer) => {
            readBytes += chunk.length;
            if (readBytes > MAX_ENTRY_UNCOMPRESSED_BYTES) {
              readStream.destroy();
              skipped.push({ fileName, reason: 'entry exceeded size limit during extraction' });
              zipfile.readEntry();
              return;
            }
            chunks.push(chunk);
          });

          readStream.on('end', () => {
            if (settled || readBytes > MAX_ENTRY_UNCOMPRESSED_BYTES) return;
            accepted.push({ fileName, buffer: Buffer.concat(chunks) });
            zipfile.readEntry();
          });

          readStream.on('error', () => {
            skipped.push({ fileName, reason: 'stream error while reading entry' });
            zipfile.readEntry();
          });
        });
      });

      zipfile.on('end', finish);
      zipfile.on('error', (err) => abort(`Zip read error: ${err.message}`));
    });
  });
}

export function safeExtractSkillTarball(tarballBuffer: Buffer): Promise<SafeSkillPackageResult> {
  return new Promise((resolve, reject) => {
    let gunzipped: Buffer;
    try {
      gunzipped = gunzipSync(tarballBuffer);
    } catch (err) {
      reject(new SkillPackageError(`Not a valid gzip tarball: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const extract = tarStream.extract();
    const accepted: SafeSkillEntry[] = [];
    const skipped: { fileName: string; reason: string }[] = [];
    let entryCount = 0;
    let totalUncompressed = 0;
    let settled = false;

    const abort = (reason: string) => {
      if (settled) return;
      settled = true;
      extract.destroy();
      reject(new SkillPackageError(reason));
    };

    extract.on('entry', (header, stream, next) => {
      if (settled) { stream.resume(); return; }

      if (header.type !== 'file') {
        stream.resume();
        next();
        return;
      }

      entryCount++;
      if (entryCount > MAX_ENTRIES) {
        stream.resume();
        abort(`Archive has more than ${MAX_ENTRIES} entries — rejected`);
        return;
      }

      const fileName = header.name;
      if (fileName.startsWith('/') || fileName.includes('..') || fileName.includes('\0')) {
        stream.resume();
        abort(`Archive contains an unsafe entry path: ${fileName}`);
        return;
      }

      const size = header.size ?? 0;
      if (size > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        skipped.push({ fileName, reason: `entry exceeds ${MAX_ENTRY_UNCOMPRESSED_BYTES}-byte limit` });
        stream.resume();
        next();
        return;
      }

      totalUncompressed += size;
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        stream.resume();
        abort(`Archive exceeds the total uncompressed size limit of ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`);
        return;
      }

      const dot = fileName.lastIndexOf('.');
      const ext = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        skipped.push({ fileName, reason: `unsupported file type "${ext || '(none)'}"` });
        stream.resume();
        next();
        return;
      }

      const chunks: Buffer[] = [];
      let readBytes = 0;
      stream.on('data', (chunk: Buffer) => {
        readBytes += chunk.length;
        if (readBytes > MAX_ENTRY_UNCOMPRESSED_BYTES) {
          stream.destroy();
          skipped.push({ fileName, reason: 'entry exceeded size limit during extraction' });
          next();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (settled || readBytes > MAX_ENTRY_UNCOMPRESSED_BYTES) return;
        accepted.push({ fileName, buffer: Buffer.concat(chunks) });
        next();
      });
      stream.on('error', () => {
        skipped.push({ fileName, reason: 'stream error while reading entry' });
        next();
      });
    });

    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      try {
        const { entries, manifestSource } = findManifest(accepted);
        resolve({ accepted: entries, skipped, manifestSource });
      } catch (err) {
        reject(err);
      }
    });
    extract.on('error', (err) => abort(`Tarball read error: ${err.message}`));

    extract.end(gunzipped);
  });
}

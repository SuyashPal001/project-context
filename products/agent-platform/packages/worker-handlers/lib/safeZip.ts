import yauzl from 'yauzl';

// Guards against zip bombs (absolute size caps + compression-ratio check,
// since a ratio check alone is defeated by many small entries and a size cap
// alone is defeated by one entry with an extreme ratio) and zip-slip (path
// traversal via entry names). Deliberately conservative — this runs on
// archives uploaded by any authenticated user, not just trusted content.
const MAX_ENTRIES = 200;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB per file
const MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200MB per archive
const MAX_COMPRESSION_RATIO = 100;
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt'];

export class ZipSafetyError extends Error {}

export interface SafeZipEntry {
  fileName: string;
  buffer: Buffer;
}

export interface SafeZipResult {
  accepted: SafeZipEntry[];
  skipped: { fileName: string; reason: string }[];
}

/**
 * Extracts only PDF/DOCX/TXT entries from a zip buffer, rejecting the whole
 * archive (not just the offending entry) on anything that looks like an
 * attack rather than an ordinary unsupported file. Entries that are merely
 * unsupported (images, executables, nested archives) are skipped, not
 * rejected — that's a normal "this file wasn't relevant" outcome, not a
 * safety violation.
 */
export function safeExtractZip(zipBuffer: Buffer): Promise<SafeZipResult> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(new ZipSafetyError(`Not a valid zip archive: ${openErr?.message ?? 'unknown error'}`));
        return;
      }

      const accepted: SafeZipEntry[] = [];
      const skipped: { fileName: string; reason: string }[] = [];
      let entryCount = 0;
      let totalUncompressed = 0;
      let settled = false;

      const abort = (reason: string) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(new ZipSafetyError(reason));
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ accepted, skipped });
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

        // Directory entries carry no content.
        if (/[/\\]$/.test(fileName)) {
          zipfile.readEntry();
          return;
        }

        // Zip-slip: absolute paths, parent-traversal, or embedded nulls are
        // never legitimate in a document archive — reject the whole upload.
        if (fileName.startsWith('/') || fileName.includes('..') || fileName.includes('\0')) {
          abort(`Archive contains an unsafe entry path: ${fileName}`);
          return;
        }

        // Never extract archives within archives.
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
            // Defends against a compressed stream that decompresses to more
            // than its own central-directory header claims.
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

export function isZipArchive(mimeType: string, fileName: string): boolean {
  return mimeType === 'application/zip'
    || mimeType === 'application/x-zip-compressed'
    || fileName.toLowerCase().endsWith('.zip');
}

import { and, eq } from 'drizzle-orm';
import { storageService } from '@serverless-saas/storage';
import { creativeBrand, type CreativeBrand, type NewCreativeBrand } from '@serverless-saas/agent-schema/creativeBrand';
import { db } from '../db';
import type { BrandFill, BrandPatch, BrandRecord, BrandRegion, EmojiPolicy } from './brandSchema';

/** A run older than this is reported failed: the workflow died without reporting. */
export const IMPORT_STALE_MS = 180_000;
const STALE_REASON = 'import did not report back in time';

// Fill keys an import may write, in API (camelCase) names — the same names
// edited_by_user stores.
const FILL_KEYS = [
  'name', 'oneLiner', 'audience', 'region', 'toneWords', 'emojiPolicy',
  'signaturePhrases', 'ctaExamples', 'voiceNotes', 'colors', 'headlineFont',
] as const;

const isEmpty = (v: unknown) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

export function effectiveImportStatus(row: CreativeBrand, now: Date = new Date()): { status: BrandRecord['importStatus']; error: string | null } {
  const status = row.importStatus as BrandRecord['importStatus'];
  if (status === 'importing' && row.importStartedAt && now.getTime() - row.importStartedAt.getTime() > IMPORT_STALE_MS) {
    return { status: 'failed', error: STALE_REASON };
  }
  return { status, error: row.importError };
}

export function toBrandRecord(
  row: CreativeBrand,
  urls: Partial<Record<'logo' | 'favicon' | 'mascot', string | null>>,
  now: Date = new Date(),
): BrandRecord {
  const image = (fileId: string | null, url: string | null | undefined) => (fileId ? { fileId, url: url ?? null } : null);
  const missing: BrandRecord['missing'] = [];
  if (!row.name?.trim()) missing.push('name');
  if (!row.audience?.trim()) missing.push('audience');
  if (row.toneWords.length === 0) missing.push('voice');
  return {
    name: row.name, oneLiner: row.oneLiner, audience: row.audience,
    region: row.region as BrandRegion, toneWords: row.toneWords, emojiPolicy: row.emojiPolicy as EmojiPolicy,
    signaturePhrases: row.signaturePhrases, bannedPhrases: row.bannedPhrases, ctaExamples: row.ctaExamples,
    voiceNotes: row.voiceNotes, colors: row.colors ?? {}, headlineFont: row.headlineFont,
    logo: image(row.logoFileId, urls.logo), favicon: image(row.faviconFileId, urls.favicon), mascot: image(row.mascotFileId, urls.mascot),
    sourceType: row.sourceType as BrandRecord['sourceType'], sourceValue: row.sourceValue,
    importStatus: effectiveImportStatus(row, now).status,
    importedAt: row.importedAt ? row.importedAt.toISOString() : null,
    ready: missing.length === 0, missing,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The columns an import result writes: skips user-edited and empty fields; keeps only verbatim signature phrases. */
export function mergeImport(row: CreativeBrand, fill: BrandFill, sourceText: string): Partial<NewCreativeBrand> {
  const edited = new Set(row.editedByUser);
  const haystack = sourceText.toLowerCase();
  const values: Record<string, unknown> = {
    ...fill,
    signaturePhrases: fill.signaturePhrases.filter((p) => haystack.includes(p.toLowerCase())),
  };
  const out: Record<string, unknown> = {};
  for (const key of FILL_KEYS) {
    if (edited.has(key)) continue;
    const v = values[key];
    if (isEmpty(v)) continue;
    out[key] = v;
  }
  return out as Partial<NewCreativeBrand>;
}

export async function getBrandRow(tenantId: string): Promise<CreativeBrand | null> {
  const [row] = await db.select().from(creativeBrand).where(eq(creativeBrand.tenantId, tenantId)).limit(1);
  return row ?? null;
}

export async function getBrand(tenantId: string): Promise<BrandRecord | null> {
  const row = await getBrandRow(tenantId);
  if (!row) return null;
  const url = async (fileId: string | null) => {
    if (!fileId) return null;
    try { return await storageService.getDownloadUrl(tenantId, fileId); } catch (err) {
      console.warn('Failed to get download URL', { tenantId, fileId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const [logo, favicon, mascot] = await Promise.all([url(row.logoFileId), url(row.faviconFileId), url(row.mascotFileId)]);
  return toBrandRecord(row, { logo, favicon, mascot });
}

export async function startImport(tenantId: string, userId: string, source: { type: 'website' | 'instagram'; value: string }): Promise<void> {
  const now = new Date();
  const fields = {
    sourceType: source.type, sourceValue: source.value, importStatus: 'importing',
    importError: null, importStartedAt: now,
  };
  await db.insert(creativeBrand)
    .values({ tenantId, createdBy: userId, ...fields })
    .onConflictDoUpdate({ target: creativeBrand.tenantId, set: fields });
}

export async function markImportFailed(tenantId: string, reason: string): Promise<void> {
  await db.update(creativeBrand)
    .set({ importStatus: 'failed', importError: reason.slice(0, 500) })
    .where(and(eq(creativeBrand.tenantId, tenantId), eq(creativeBrand.importStatus, 'importing')));
}

/** Saves the user's fields and records them in edited_by_user. Creates the row (source 'chat') if none. */
export async function patchBrand(tenantId: string, userId: string, patch: BrandPatch): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const existing = await getBrandRow(tenantId);
  // Image keys are stored under the image name ('logo'), the rest under their own name.
  const editedKeys = keys.map((k) => k.replace(/FileId$/, ''));
  const editedByUser = Array.from(new Set([...(existing?.editedByUser ?? []), ...editedKeys]));
  if (!existing) {
    await db.insert(creativeBrand)
      .values({ tenantId, createdBy: userId, sourceType: 'chat', ...patch, editedByUser })
      .onConflictDoUpdate({ target: creativeBrand.tenantId, set: { ...patch, editedByUser } });
    return;
  }
  await db.update(creativeBrand).set({ ...patch, editedByUser }).where(eq(creativeBrand.tenantId, tenantId));
}

/** Applies an import result unless the row moved on (a newer import, or none running). */
export async function applyImportResult(
  tenantId: string, fill: BrandFill, sourceText: string,
  images: { logoFileId?: string; faviconFileId?: string },
): Promise<'applied' | 'ignored'> {
  const row = await getBrandRow(tenantId);
  if (!row || row.importStatus !== 'importing') return 'ignored';
  const edited = new Set(row.editedByUser);
  const set: Partial<NewCreativeBrand> = {
    ...mergeImport(row, fill, sourceText),
    ...(images.logoFileId && !edited.has('logo') ? { logoFileId: images.logoFileId } : {}),
    ...(images.faviconFileId && !edited.has('favicon') ? { faviconFileId: images.faviconFileId } : {}),
    importStatus: 'done', importError: null, importedAt: new Date(),
  };
  const result = await db.update(creativeBrand).set(set)
    .where(and(eq(creativeBrand.tenantId, tenantId), eq(creativeBrand.importStatus, 'importing')))
    .returning({ id: creativeBrand.id });
  return result.length > 0 ? 'applied' : 'ignored';
}

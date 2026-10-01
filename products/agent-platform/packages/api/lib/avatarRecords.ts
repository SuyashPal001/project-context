import { and, desc, eq, isNotNull, isNull, like, sql } from 'drizzle-orm';
import { storageService } from '@serverless-saas/storage';
import { files } from '@serverless-saas/database/schema/storage';
import { creativeLibraryAssets } from '@serverless-saas/agent-schema/creativeLibraryAssets';
import { db } from '../db';
import { escapeLike, productFileName, ALLOWED_PRODUCT_IMAGE_TYPES } from './productRecords';
import { MAX_NAMING_IMAGE_BYTES } from './productNaming';
import { cleanupOrphanedAvatars } from './avatarCleanup';

/** Drive's "Avatars" folder — the prefix the picker and Drive both upload into. */
export const AVATAR_PREFIX = 'creative-avatars/';
/** Identity reference sheets for avatars — images the orchestrator copies here for identity views. */
export const AVATAR_REFS_PREFIX = 'avatar-refs/';
const ORCHESTRATOR_TIMEOUT_MS = 20_000;
const MAX_TENANT_AVATARS = 200;

export type AvatarNamingStatus = 'pending' | 'done' | 'failed';
export interface AvatarAttributes {
  role?: string | null;
  tone?: string | null;
  namingStatus?: AvatarNamingStatus;
  referenceSheetFileId?: string;
  terseTag?: string;
  styleLock?: string;
  sourceFileId?: string;
  // Picker filter, set when an avatar is saved from an avatar skill.
  category?: AvatarCategory;
}
export type AvatarCategory = 'UGC' | 'Animation' | 'TVC';
export interface TenantAvatarRecord {
  id: string;
  fileId: string;
  name: string;
  role: string | null;
  tone: string | null;
  namingStatus: AvatarNamingStatus;
  referenceSheetFileId: string | null;
  category: AvatarCategory | null;
  type: string;
  size: number;
  createdAt: string;
}

// From d241b29b (2026-09-15) to 6d018c85 (2026-09-23) the picker re-uploaded
// a platform preset into the Avatars folder on every pick, as
// creative-avatars/<uuid>-<preset-id>.jpg named "<preset-id>.jpg". Those are
// copies of presets, not the tenant's own avatars: never register them (and so
// never AI-rename them, which would also hide them from a later cleanup).
const PRESET_COPY_IDS = ['everyday-creator', 'tech-presenter', 'beauty-creator', 'fitness-host', 'lifestyle-creator', 'friendly-storyteller'];
const PRESET_COPY_KEY = new RegExp(`^${AVATAR_PREFIX}[0-9a-f-]{36}-(${PRESET_COPY_IDS.join('|')})\\.jpg$`);

export function isPresetCopy(file: { key: string; name: string }): boolean {
  const match = PRESET_COPY_KEY.exec(file.key);
  return !!match && file.name === `${match[1]}.jpg`;
}

/** "IMG_4432.jpg" → "IMG_4432": what a tenant avatar is called until naming lands (or if it fails). */
export function avatarPlaceholderName(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim().slice(0, 60) || 'My avatar';
}

type Row = { id: string; fileId: string | null; name: string; attributes: unknown; createdAt: Date; mimeType: string | null; size: number | null };

function toRecord(row: Row): TenantAvatarRecord {
  const attrs = (row.attributes ?? {}) as AvatarAttributes;
  return {
    id: row.id,
    fileId: row.fileId!,
    name: row.name,
    role: attrs.role ?? null,
    tone: attrs.tone ?? null,
    namingStatus: attrs.namingStatus ?? 'done',
    referenceSheetFileId: attrs.referenceSheetFileId ?? null,
    category: attrs.category ?? null,
    type: row.mimeType ?? 'image/jpeg',
    size: row.size ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

const selection = {
  id: creativeLibraryAssets.id,
  fileId: creativeLibraryAssets.fileId,
  name: creativeLibraryAssets.name,
  attributes: creativeLibraryAssets.attributes,
  createdAt: creativeLibraryAssets.createdAt,
  mimeType: files.mimeType,
  size: files.size,
};

/**
 * Gives every avatar image in the tenant's Avatars folder a library row.
 * Drive's "New avatar" upload is a plain file upload with no avatar step, so
 * rows are created here rather than at upload time — whichever way the photo
 * arrived, it shows in the picker. Idempotent: file_id is unique.
 */
export async function syncTenantAvatars(tenantId: string): Promise<void> {
  const unregistered = await db
    .select({ id: files.id, name: files.name, key: files.key, mimeType: files.mimeType })
    .from(files)
    .leftJoin(creativeLibraryAssets, eq(creativeLibraryAssets.fileId, files.id))
    .where(and(
      eq(files.tenantId, tenantId),
      eq(files.status, 'uploaded'),
      isNull(files.deletedAt),
      like(files.key, `${escapeLike(AVATAR_PREFIX)}%`),
      isNull(creativeLibraryAssets.id),
    ))
    .limit(MAX_TENANT_AVATARS);
  const images = unregistered.filter((f) => ALLOWED_PRODUCT_IMAGE_TYPES.has(f.mimeType ?? '') && !isPresetCopy(f));
  if (images.length === 0) return;
  await db.insert(creativeLibraryAssets).values(images.map((f) => ({
    tenantId,
    slug: `file-${f.id}`,
    kind: 'avatar' as const,
    name: avatarPlaceholderName(f.name),
    attributes: { namingStatus: 'pending' } satisfies AvatarAttributes,
    storageKey: f.key,
    mimeType: f.mimeType!,
    fileId: f.id,
  }))).onConflictDoNothing();
}

/** The tenant's own avatars, newest first. A deleted file hides its avatar. */
export async function listTenantAvatars(tenantId: string): Promise<TenantAvatarRecord[]> {
  await cleanupOrphanedAvatars(tenantId);
  await syncTenantAvatars(tenantId);
  const rows = await db
    .select(selection)
    .from(creativeLibraryAssets)
    .innerJoin(files, eq(files.id, creativeLibraryAssets.fileId))
    .where(and(
      eq(creativeLibraryAssets.tenantId, tenantId),
      eq(creativeLibraryAssets.kind, 'avatar'),
      eq(creativeLibraryAssets.status, 'active'),
      isNotNull(creativeLibraryAssets.fileId),
      eq(files.tenantId, tenantId),
      isNull(files.deletedAt),
    ))
    .orderBy(desc(creativeLibraryAssets.createdAt), desc(creativeLibraryAssets.id))
    .limit(MAX_TENANT_AVATARS);
  return rows.map(toRecord);
}

export async function getTenantAvatar(tenantId: string, where: { id: string } | { fileId: string }): Promise<TenantAvatarRecord | null> {
  const [row] = await db
    .select(selection)
    .from(creativeLibraryAssets)
    .innerJoin(files, eq(files.id, creativeLibraryAssets.fileId))
    .where(and(
      eq(creativeLibraryAssets.tenantId, tenantId),
      eq(creativeLibraryAssets.kind, 'avatar'),
      'id' in where ? eq(creativeLibraryAssets.id, where.id) : eq(creativeLibraryAssets.fileId, where.fileId),
      eq(files.tenantId, tenantId),
      isNull(files.deletedAt),
    ))
    .limit(1);
  return row ? toRecord(row) : null;
}

/**
 * The tenant's active avatar registered from a given source file (e.g. a
 * generated portrait the user chose to keep as an avatar), or null when none
 * is registered yet. Backs idempotent registration: a caller checks this
 * before creating a new avatar for the same source.
 */
export async function findTenantAvatarBySource(tenantId: string, sourceFileId: string): Promise<TenantAvatarRecord | null> {
  const [row] = await db
    .select(selection)
    .from(creativeLibraryAssets)
    .innerJoin(files, eq(files.id, creativeLibraryAssets.fileId))
    .where(and(
      eq(creativeLibraryAssets.tenantId, tenantId),
      eq(creativeLibraryAssets.kind, 'avatar'),
      eq(creativeLibraryAssets.status, 'active'),
      eq(sql`${creativeLibraryAssets.attributes}->>'sourceFileId'`, sourceFileId),
      eq(files.tenantId, tenantId),
      isNull(files.deletedAt),
    ))
    .limit(1);
  if (!row) return null;
  const record = toRecord(row);
  // Finding #4: a reuse hit whose pinned reference sheet was deleted (or
  // otherwise missing) elsewhere must not report it as present — the caller
  // (save_as_avatar) relies on this to decide whether it still needs to add
  // one, and a dangling id would make it skip that.
  if (record.referenceSheetFileId) {
    const [sheet] = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.tenantId, tenantId), eq(files.id, record.referenceSheetFileId), isNull(files.deletedAt)))
      .limit(1);
    if (!sheet) record.referenceSheetFileId = null;
  }
  return record;
}

/** Pins the source file (and picker category) this avatar was registered with. Merges into attributes, never replaces it. */
export async function setAvatarSource(tenantId: string, id: string, sourceFileId?: string, category?: AvatarCategory): Promise<void> {
  const patch: AvatarAttributes = { ...(sourceFileId ? { sourceFileId } : {}), ...(category ? { category } : {}) };
  await db.update(creativeLibraryAssets)
    .set({ attributes: sql`${creativeLibraryAssets.attributes} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(creativeLibraryAssets.tenantId, tenantId), eq(creativeLibraryAssets.id, id)));
}

/**
 * Relays naming to the orchestrator (the API Lambda has no gateway URL), same
 * as productNaming.ts. Never throws: any failure returns null.
 */
export async function describeAvatarImage(
  tenantId: string, avatar: TenantAvatarRecord,
): Promise<{ name: string; role: string | null; tone: string | null } | null> {
  const baseUrl = process.env.AGENT_ORCHESTRATOR_URL;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    console.error('[avatarRecords] AGENT_ORCHESTRATOR_URL or INTERNAL_SERVICE_KEY not set — skipping naming');
    return null;
  }
  if (avatar.size > MAX_NAMING_IMAGE_BYTES) return null;
  try {
    const imageUrl = await storageService.getDownloadUrl(tenantId, avatar.fileId);
    const res = await fetch(`${baseUrl}/internal/avatars/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify({ tenantId, imageUrl, mimeType: avatar.type, ...(avatar.category ? { category: avatar.category } : {}) }),
      signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('[avatarRecords] orchestrator returned', res.status, { tenantId, fileId: avatar.fileId });
      return null;
    }
    const body = await res.json() as { name?: unknown; role?: unknown; tone?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) return null;
    const label = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);
    return { name, role: label(body.role), tone: label(body.tone) };
  } catch (error) {
    console.error('[avatarRecords] naming failed', { tenantId, fileId: avatar.fileId, error: (error as Error).message });
    return null;
  }
}

/**
 * Names a pending avatar and renames its Drive file to match ("Riya.jpg").
 * Only a still-pending row takes the result, so two concurrent calls can't
 * both apply. Returns the fresh record, or null when the tenant has no such avatar.
 */
export async function nameTenantAvatar(tenantId: string, id: string): Promise<TenantAvatarRecord | null> {
  const avatar = await getTenantAvatar(tenantId, { id });
  if (!avatar || avatar.namingStatus !== 'pending') return avatar;
  const result = await describeAvatarImage(tenantId, avatar);
  // Merge into attributes via jsonb `||`, never replace it: setAvatarReference
  // can pin referenceSheetFileId/terseTag/styleLock onto a still-pending
  // avatar before naming finishes (inline budget 10s vs orchestrator's 20s
  // timeout, or the picker's own retry loop calling describe on a pending
  // avatar) — a plain-object .set() here would silently wipe them (Finding #1).
  const patch: AvatarAttributes = result
    ? { role: result.role, tone: result.tone, namingStatus: 'done' }
    : { namingStatus: 'failed' };
  const [updated] = await db
    .update(creativeLibraryAssets)
    .set({
      ...(result ? { name: result.name } : {}),
      attributes: sql`${creativeLibraryAssets.attributes} || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(and(
      eq(creativeLibraryAssets.tenantId, tenantId),
      eq(creativeLibraryAssets.id, id),
      sql`${creativeLibraryAssets.attributes}->>'namingStatus' = 'pending'`,
    ))
    .returning({ name: creativeLibraryAssets.name, fileId: creativeLibraryAssets.fileId });
  if (result && updated?.fileId) {
    try {
      const [file] = await db.select({ name: files.name, mimeType: files.mimeType }).from(files)
        .where(and(eq(files.tenantId, tenantId), eq(files.id, updated.fileId))).limit(1);
      const fileName = file ? productFileName(updated.name, 0, file.name, file.mimeType) : null;
      if (file && fileName !== file.name) {
        await db.update(files).set({ name: fileName!, updatedAt: new Date() })
          .where(and(eq(files.tenantId, tenantId), eq(files.id, updated.fileId)));
      }
    } catch (error) {
      // The avatar name is the source of truth; a failed file rename is cosmetic.
      console.error('[avatarRecords] renaming avatar file failed', { tenantId, id, error: (error as Error).message });
    }
  }
  return getTenantAvatar(tenantId, { id });
}

/** Below this there's no point starting: a Gemini describe takes longer. */
const MIN_NAMING_BUDGET_MS = 2_000;

/**
 * Names an avatar within the request, bounded by `budgetMs` — the web proxy
 * aborts at 15 s and naming can take up to 20 s. Past the budget the avatar
 * comes back still pending and the picker's retry finishes it. Never throws.
 */
export async function nameTenantAvatarWithin(tenantId: string, avatar: TenantAvatarRecord, budgetMs: number): Promise<TenantAvatarRecord> {
  if (avatar.namingStatus !== 'pending' || budgetMs < MIN_NAMING_BUDGET_MS) return avatar;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
  try {
    return (await Promise.race([nameTenantAvatar(tenantId, avatar.id), outOfTime])) ?? avatar;
  } catch (error) {
    console.error('[avatarRecords] naming a new avatar failed', { tenantId, id: avatar.id, error: (error as Error).message });
    return avatar;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pins a reference sheet (identity views) and its identity anchor to a tenant
 * avatar. The sheet must be the tenant's own image under avatar-refs/, so it
 * never shows as an avatar itself. Merges into attributes, keeping naming.
 * Returns the fresh record, null for an unknown avatar, or 'invalid_sheet'.
 */
export async function setAvatarReference(
  tenantId: string, id: string, input: { referenceSheetFileId: string; terseTag: string; styleLock: string; category?: AvatarCategory },
): Promise<TenantAvatarRecord | null | 'invalid_sheet'> {
  const avatar = await getTenantAvatar(tenantId, { id });
  if (!avatar) return null;
  const [sheet] = await db.select({ key: files.key, mimeType: files.mimeType }).from(files)
    .where(and(eq(files.tenantId, tenantId), eq(files.id, input.referenceSheetFileId), isNull(files.deletedAt)))
    .limit(1);
  if (!sheet || !sheet.key.startsWith(AVATAR_REFS_PREFIX) || !ALLOWED_PRODUCT_IMAGE_TYPES.has(sheet.mimeType ?? '')) return 'invalid_sheet';
  const patch: AvatarAttributes = {
    referenceSheetFileId: input.referenceSheetFileId, terseTag: input.terseTag, styleLock: input.styleLock,
    ...(input.category ? { category: input.category } : {}),
  };
  await db.update(creativeLibraryAssets)
    .set({ attributes: sql`${creativeLibraryAssets.attributes} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(creativeLibraryAssets.tenantId, tenantId), eq(creativeLibraryAssets.id, id)));
  return getTenantAvatar(tenantId, { id });
}

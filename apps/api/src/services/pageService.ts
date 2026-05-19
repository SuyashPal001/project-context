import { randomUUID } from 'crypto'
import pg from 'pg'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Page {
  id: string
  tenantId: string
  planId: string | null
  parentId: string | null
  ownedBy: string
  createdBy: string
  title: string
  descriptionHtml: string
  descriptionJson: Record<string, unknown>
  descriptionStripped: string | null
  pageType: string
  source: string
  access: number
  isLocked: boolean
  archivedAt: string | null
  sortOrder: number
  documentId: string | null
  createdAt: string
  updatedAt: string
}

export interface PageVersion {
  id: string
  tenantId: string
  pageId: string
  ownedBy: string
  descriptionHtml: string
  descriptionJson: Record<string, unknown>
  descriptionStripped: string | null
  lastSavedAt: string
  createdAt: string
}

export interface CreatePageData {
  title?: string
  pageType?: string
  parentId?: string
  access?: number
}

export interface SavePageData {
  title?: string
  descriptionHtml?: string
  descriptionJson?: Record<string, unknown>
}

// ─── Pool singleton (exported for pageSaveService) ────────────────────────────

let _pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => {
      console.error('[pageService] pool error:', err.message)
    })
  }
  return _pool
}

// ─── Row mappers (exported for pageSaveService) ───────────────────────────────

export function rowToPage(r: Record<string, unknown>): Page {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    planId: r.plan_id as string | null,
    parentId: r.parent_id as string | null,
    ownedBy: r.owned_by as string,
    createdBy: r.created_by as string,
    title: r.title as string,
    descriptionHtml: r.description_html as string,
    descriptionJson: (r.description_json ?? {}) as Record<string, unknown>,
    descriptionStripped: r.description_stripped as string | null,
    pageType: r.page_type as string,
    source: r.source as string,
    access: r.access as number,
    isLocked: r.is_locked as boolean,
    archivedAt: r.archived_at as string | null,
    sortOrder: r.sort_order as number,
    documentId: r.document_id as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

export function rowToVersion(r: Record<string, unknown>): PageVersion {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    pageId: r.page_id as string,
    ownedBy: r.owned_by as string,
    descriptionHtml: r.description_html as string,
    descriptionJson: (r.description_json ?? {}) as Record<string, unknown>,
    descriptionStripped: r.description_stripped as string | null,
    lastSavedAt: r.last_saved_at as string,
    createdAt: r.created_at as string,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createPage(
  tenantId: string,
  userId: string,
  planId: string,
  data: CreatePageData,
): Promise<Page> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `INSERT INTO project_pages
       (id, tenant_id, plan_id, parent_id, owned_by, created_by, title, page_type, access)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)
     RETURNING *`,
    [
      randomUUID(), tenantId, planId,
      data.parentId ?? null, userId,
      data.title ?? 'Untitled', data.pageType ?? 'custom', data.access ?? 0,
    ],
  )
  return rowToPage(rows[0])
}

export async function listPages(tenantId: string, planId: string): Promise<Page[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT * FROM project_pages
     WHERE tenant_id = $1 AND plan_id = $2 AND archived_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [tenantId, planId],
  )
  return rows.map(rowToPage)
}

export async function getPage(tenantId: string, pageId: string): Promise<Page | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT * FROM project_pages
     WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`,
    [tenantId, pageId],
  )
  return rows.length ? rowToPage(rows[0]) : null
}

export async function archivePage(tenantId: string, pageId: string): Promise<void> {
  await getPool().query(
    `UPDATE project_pages SET archived_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, pageId],
  )
}

export async function toggleLock(
  tenantId: string,
  _userId: string,
  pageId: string,
): Promise<Page> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `UPDATE project_pages
     SET is_locked = NOT is_locked, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL
     RETURNING *`,
    [tenantId, pageId],
  )
  if (!rows.length) throw new Error('Page not found')
  return rowToPage(rows[0])
}

export async function listVersions(
  tenantId: string,
  pageId: string,
): Promise<PageVersion[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT * FROM project_page_versions
     WHERE tenant_id = $1 AND page_id = $2
     ORDER BY last_saved_at DESC
     LIMIT 20`,
    [tenantId, pageId],
  )
  return rows.map(rowToVersion)
}

export async function duplicatePage(
  tenantId: string,
  userId: string,
  pageId: string,
): Promise<Page> {
  const source = await getPage(tenantId, pageId)
  if (!source) throw new Error('Page not found')
  const { rows } = await getPool().query<Record<string, unknown>>(
    `INSERT INTO project_pages
       (id, tenant_id, plan_id, parent_id, owned_by, created_by,
        title, description_html, description_json, description_stripped,
        page_type, source, access)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
     RETURNING *`,
    [
      randomUUID(), tenantId, source.planId, source.parentId,
      userId, `Copy of ${source.title}`,
      source.descriptionHtml, JSON.stringify(source.descriptionJson),
      source.descriptionStripped,
      source.pageType, 'human', source.access,
    ],
  )
  return rowToPage(rows[0])
}

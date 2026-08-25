import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { embedQuery } from '@serverless-saas/ai'
import { listGrantedFiles, executeSql, type GrantedFile } from './folderScope.js'

const MAX_MATCHES = 5

interface Match {
  fileId: string
  filename: string
  contentType: string
  score: number
  why: string
}

/** Filenames carry real signal in a Drive folder — "budget-2026.xlsx" routes a
 *  question about the budget without a single chunk having been indexed. This is
 *  what makes tier 1 useful before any ingestion has run. */
function matchOnFilename(granted: GrantedFile[], query: string): Match[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return granted
    .filter(f => terms.some(t => f.filename.toLowerCase().includes(t)))
    .slice(0, MAX_MATCHES)
    .map(f => ({
      fileId: f.fileId,
      filename: f.filename,
      contentType: f.contentType,
      score: 0.1,
      why: 'matched on filename only — this file has not been indexed yet',
    }))
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown }
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>
}

/**
 * Tier 1 routing. Answers "which of these files should I read?", never "what do
 * they say" — it returns a ranked list of files and no prose, so the agent
 * spends a read on one file rather than pulling a folder into context.
 *
 * Ranks on indexed chunk content where it exists and falls back to filenames
 * where it does not, because most of a Drive folder is media that no ingestion
 * job has touched.
 */
export const findInFolderTool = createTool({
  id: 'find_in_folder',
  description: 'Find which files in the granted folder are relevant to a question. Returns a ranked list of files — not their contents. Read the top result with read_file.',
  inputSchema: z.object({ query: z.string().min(1) }),
  outputSchema: z.object({
    matches: z.array(z.object({
      fileId: z.string(),
      filename: z.string(),
      contentType: z.string(),
      score: z.number(),
      why: z.string(),
    })),
    note: z.string().optional(),
  }),
  execute: async ({ query }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
    const prefix = (execContext as any)?.requestContext?.get('folderPrefix') as string | undefined
    if (!tenantId || !prefix) {
      return { matches: [], note: 'No folder has been granted to this conversation.' }
    }

    const granted = await listGrantedFiles(tenantId, prefix)
    if (granted.length === 0) return { matches: [], note: 'The granted folder is empty.' }

    // The grant is the universe: ranked rows are looked up in this map, so a row
    // for anything outside it is dropped rather than surfaced.
    const byId = new Map(granted.map(f => [f.fileId, f]))
    const ids = granted.map(f => f.fileId)

    let indexed: Match[] = []
    try {
      // documents.file_key holds a fileId uuid despite its name — verified on
      // dev, where joining on files.key returns 0 rows and this returns 21 of 26.
      const embedding = await embedQuery(query)
      const vectorStr = `[${embedding.join(',')}]`
      const result = await executeSql(sql`
        SELECT d.file_key AS file_id,
               MAX(1 - (c.embedding <=> ${vectorStr}::vector)) AS score,
               (ARRAY_AGG(LEFT(c.content, 120) ORDER BY c.chunk_index))[1] AS snippet
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.tenant_id = ${tenantId}
          AND d.file_key = ANY(${ids})
        GROUP BY d.file_key
        ORDER BY score DESC
        LIMIT ${MAX_MATCHES}
      `)
      indexed = rowsOf(result)
        .map(r => ({ file: byId.get(String(r.file_id)), score: Number(r.score), snippet: String(r.snippet ?? '') }))
        .filter((m): m is { file: GrantedFile; score: number; snippet: string } => Boolean(m.file))
        .map(m => ({
          fileId: m.file.fileId,
          filename: m.file.filename,
          contentType: m.file.contentType,
          score: m.score,
          why: `matched indexed content: "${m.snippet}"`,
        }))
    } catch (err) {
      // Ranking is a nicety; filenames still route. Losing the index must not
      // take the tool down with it.
      console.error('[findInFolder] chunk ranking failed, falling back to filenames:', (err as Error).message)
    }

    if (indexed.length > 0) return { matches: indexed }

    const byName = matchOnFilename(granted, query)
    if (byName.length === 0) {
      return { matches: [], note: 'No file in the folder matched. Use list_folder to see what is there.' }
    }
    return { matches: byName }
  },
})

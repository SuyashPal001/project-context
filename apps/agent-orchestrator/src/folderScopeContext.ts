import type { RequestContext } from '@mastra/core/request-context'

const MAX_PREFIX_LENGTH = 512

/**
 * Read a folder grant off a chat request body.
 *
 * The API validates a prefix when it is stored on the conversation, but this
 * value arrives on the request body, so it is re-checked here rather than
 * trusted because something upstream was supposed to have checked it. The rules
 * match the API's: must end in "/" (or `key LIKE prefix || '%'` reaches a
 * sibling folder whose name merely starts the same), never absolute, never
 * traversing.
 *
 * A malformed prefix yields no grant rather than an error — the conversation
 * still works, the agent simply has no folder. Tenant isolation does not depend
 * on this value; it is enforced separately in folderScope.ts.
 */
export function resolveFolderPrefix(body: unknown): string | undefined {
  const raw = (body as Record<string, unknown> | null | undefined)?.folderPrefix
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  if (raw.length > MAX_PREFIX_LENGTH) return undefined
  if (!raw.endsWith('/')) return undefined
  if (raw.startsWith('/') || raw.includes('..')) return undefined
  return raw
}

/** Put the grant where the tools read it. Tools never take a folder as input. */
export function applyFolderScope(requestContext: RequestContext, folderPrefix: string | undefined): void {
  if (folderPrefix) requestContext.set('folderPrefix', folderPrefix)
}

/**
 * Tell the agent it has a folder, but not what is in it: the manifest is a tool
 * call, so a thousand-file folder never lands in the prompt.
 */
export function folderScopeLine(folderPrefix: string | undefined): string {
  if (!folderPrefix) return ''
  return `\nfolder: ${folderPrefix} — use list_folder to see what is in it, find_in_folder to choose a file, read_file to read one`
}

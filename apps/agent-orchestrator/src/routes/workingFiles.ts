import type { AttachmentPayload } from '../persistence.js'

// A finished ad used to land with every file the pipeline made attached to
// the reply — 4 narrations, 4 beat clips, the joined, captioned and carded
// versions, then the final (13 cards, 2026-10-06). A file a later step of the
// same turn took as an input is a working file: it is still saved and kept
// on the message, but marked so the chat folds it away behind one row. What
// is left unmarked is what the turn actually produced for the user.

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Tools that only show a file to the user (a review question, show_files)
// do not use it as an input: the Scene 1 still was folded away as a working
// file because the review question was given its id (2026-10-07). A quality
// check only looks at a file too: check_clip on the Scene 2 and 3 stills
// folded both away, so the part had no hand-over line and no card (2026-10-07).
const SHOWS_ONLY = /^(review_shots|show_files|ask_clarifying_questions|check_clip|check_still)$/

/** The file ids a tool call takes as inputs; none for a tool that only shows files. */
export function inputFileIdsOf(toolName: string, args: unknown, into: Set<string>): Set<string> {
  return SHOWS_ONLY.test(toolName.replace(/-/g, '_')) ? into : fileIdsIn(args, into)
}

/** Every file id anywhere in a tool call's arguments. */
export function fileIdsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (FILE_ID.test(value)) into.add(value.toLowerCase())
  } else if (Array.isArray(value)) {
    for (const v of value) fileIdsIn(v, into)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) fileIdsIn(v, into)
  }
  return into
}

export function markWorkingFiles(attachments: AttachmentPayload[], inputIds: Set<string>): AttachmentPayload[] {
  return attachments.map((a) => (inputIds.has(a.fileId.toLowerCase()) ? { ...a, working: true } : a))
}

/**
 * Whether a call made a file: its result carries a file id it was not given.
 * Any tool, attached to the reply or not — mix_voiceover's new clip is not an
 * attachment, and missing it left the joined clip and three narrations as big
 * cards under the finished ad (2026-10-07). A check or review returns no new id.
 */
export function madeNewFile(result: unknown, inputs: Set<string>): boolean {
  for (const id of fileIdsIn(result)) if (!inputs.has(id)) return true
  return false
}

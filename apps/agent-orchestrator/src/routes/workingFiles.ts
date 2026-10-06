import type { AttachmentPayload } from '../persistence.js'

// A finished ad used to land with every file the pipeline made attached to
// the reply — 4 narrations, 4 beat clips, the joined, captioned and carded
// versions, then the final (13 cards, 2026-10-06). A file a later step of the
// same turn took as an input is a working file: it is still saved and kept
// on the message, but marked so the chat folds it away behind one row. What
// is left unmarked is what the turn actually produced for the user.

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

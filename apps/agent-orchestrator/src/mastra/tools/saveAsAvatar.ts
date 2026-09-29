import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { resolveSourceImage } from '../../media.js'
import { findTenantAvatarBySource, registerTenantAvatar, setTenantAvatarReference, uploadFileWithKey } from '../../persistence.js'

const extensionFor = (mimeType: string) => mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'

// Free: it only copies files the user already paid to generate. The portrait
// goes into Drive's Avatars folder (so it shows in Drive, the picker's "Yours"
// and casting), the sheet into avatar-refs/ (never an avatar itself).
export const saveAsAvatar = createTool({
  id: 'save-as-avatar',
  description: 'Saves a generated portrait the user picked as one of their reusable avatars, with its reference sheet and identity anchor. Call once, after the reference sheet has been generated. Returns the avatar\'s name; the portrait is also named automatically.',
  inputSchema: z.object({
    portraitFileId: z.string().uuid().describe('fileId of the variation the user picked'),
    referenceSheetFileId: z.string().uuid().describe('fileId of the reference sheet generated from that portrait'),
    terseTag: z.string().min(1).max(200).describe('Short identity description used as identityAnchor.terseTag on later calls'),
    styleLock: z.string().min(1).max(200).describe('Short look/lighting description used as identityAnchor.styleLock on later calls'),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    reason: z.string().optional(),
    avatarId: z.string().optional(),
    fileId: z.string().optional(),
    name: z.string().optional(),
    role: z.string().nullable().optional(),
    tone: z.string().nullable().optional(),
    referenceSheet: z.boolean().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { portraitFileId, referenceSheetFileId, terseTag, styleLock } = inputData as {
      portraitFileId: string
      referenceSheetFileId: string
      terseTag: string
      styleLock: string
    }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = (execContext?.requestContext?.get('conversationId') as string | undefined) ?? 'unknown'
    if (!idToken) return { saved: false, reason: 'NOT_AUTHENTICATED' }

    // Idempotent per picked portrait: the same portraitFileId is the source of
    // truth for whether it was already saved, so re-running the tool on the
    // same picked portrait never creates a second avatar or re-uploads files.
    const existing = await findTenantAvatarBySource(idToken, portraitFileId)
    if (existing?.referenceSheetFileId) {
      return { saved: true, avatarId: existing.id, fileId: existing.fileId, name: existing.name, role: existing.role, tone: existing.tone, referenceSheet: true }
    }

    let avatar: { id: string; fileId: string; name: string; role: string | null; tone: string | null }
    if (existing) {
      avatar = existing
    } else {
      const portrait = await resolveSourceImage(idToken, portraitFileId, 'image/png', sessionId)
      if (!portrait) return { saved: false, reason: 'SOURCE_IMAGE_UNAVAILABLE' }
      const portraitExt = extensionFor(portrait.mimeType)
      const copy = await uploadFileWithKey(idToken, {
        key: `creative-avatars/${randomUUID()}-avatar.${portraitExt}`, name: `avatar.${portraitExt}`,
        content: Buffer.from(portrait.base64, 'base64'), contentType: portrait.mimeType,
      })
      if (!copy) return { saved: false, reason: 'STORAGE_FAILED' }

      const registered = await registerTenantAvatar(idToken, copy.fileId, portraitFileId)
      if (!registered) return { saved: false, reason: 'REGISTER_FAILED' }
      avatar = registered
    }

    // Best effort from here: the avatar is saved and usable either way.
    let referenceSheet = false
    const sheet = await resolveSourceImage(idToken, referenceSheetFileId, 'image/png', sessionId)
    if (sheet) {
      const sheetExt = extensionFor(sheet.mimeType)
      const sheetCopy = await uploadFileWithKey(idToken, {
        key: `avatar-refs/${avatar.id}/${randomUUID()}-sheet.${sheetExt}`, name: `${avatar.name} reference.${sheetExt}`,
        content: Buffer.from(sheet.base64, 'base64'), contentType: sheet.mimeType,
      })
      if (sheetCopy) referenceSheet = await setTenantAvatarReference(idToken, avatar.id, { referenceSheetFileId: sheetCopy.fileId, terseTag, styleLock })
    }
    if (!referenceSheet) console.error(`[session:${sessionId}] saveAsAvatar: avatar ${avatar.id} saved without its reference sheet`)

    return { saved: true, avatarId: avatar.id, fileId: avatar.fileId, name: avatar.name, role: avatar.role, tone: avatar.tone, referenceSheet }
  },
})

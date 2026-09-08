import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { pendingUploads, sessionActiveUpload, UPLOAD_TIMEOUT_MS } from '../../types.js'
import { saveUploadRequest, updateUploadRequest } from '../../persistence.js'

// Lets the platform agent pause mid-conversation to ask the user to upload one
// or more files (a logo, screenshots, a reference asset) before proceeding,
// instead of guessing or fabricating a placeholder. Mirrors
// askClarifyingQuestions.ts's block-via-promise shape exactly; the only real
// difference is what's being collected (fileIds via the existing chat-attachment
// upload pipeline, not a selected option) and a longer timeout since picking
// and uploading a file takes longer than answering a question.
export const requestUploadTool = createTool({
  id: 'request_upload',
  description:
    'Pause and ask the user to upload one or more files (e.g. a logo, screenshots, a reference ' +
    'image) before proceeding. Use this instead of proceeding without an asset the user has to ' +
    'provide, or instead of asking them to paste/describe something that is really a file.',
  inputSchema: z.object({
    prompt: z.string().describe('What to ask the user to upload, shown as the card body'),
    minFiles: z.number().int().min(1).optional().default(1),
    maxFiles: z.number().int().min(1).optional().default(5),
  }),
  execute: async (inputData, execContext) => {
    const sendEvent = execContext?.requestContext?.get('sendEvent') as
      ((event: string, data: object) => void) | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const userId = execContext?.requestContext?.get('userId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined

    if (!sendEvent || !sessionId || !tenantId || !userId) {
      return { files: [] as { fileId: string; name: string; mimeType: string }[], error: 'no_active_session' }
    }

    const minFiles = Math.max(1, inputData.minFiles ?? 1)
    const maxFiles = Math.max(minFiles, inputData.maxFiles ?? 5)

    const uploadId = crypto.randomUUID()
    const uploadMessageId = crypto.randomUUID()
    sendEvent('upload_request', { uploadId, prompt: inputData.prompt, minFiles, maxFiles })

    if (conversationId && idToken) {
      saveUploadRequest(idToken, conversationId, uploadMessageId, {
        id: uploadId,
        prompt: inputData.prompt,
        minFiles,
        maxFiles,
        status: 'pending',
      })
    }

    if (sessionId) sessionActiveUpload.set(sessionId, uploadId)

    const answer = await new Promise<{ files: { fileId: string; name: string; mimeType: string }[]; freeText?: string; skipped?: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        const pending = pendingUploads.get(uploadId)
        pendingUploads.delete(uploadId)
        resolve({ files: [], skipped: true })

        // Flip the DB row out of 'pending' so the message never becomes a
        // permanently invisible orphan once the agent produces a later message.
        if (pending?.messageId && pending?.conversationId && pending?.idToken) {
          updateUploadRequest(pending.idToken, pending.conversationId, pending.messageId, {
            status: 'skipped',
            answeredAt: new Date().toISOString(),
          })
        }
      }, UPLOAD_TIMEOUT_MS)
      pendingUploads.set(uploadId, {
        resolve,
        timer,
        minFiles,
        maxFiles,
        tenantId,
        userId,
        messageId: uploadMessageId,
        conversationId,
        idToken,
      })
    })

    if (sessionId) sessionActiveUpload.delete(sessionId)

    return {
      files: answer.files,
      freeText: answer.freeText,
      skipped: answer.skipped ?? false,
    }
  },
})

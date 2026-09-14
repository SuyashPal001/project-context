import type { ClarificationRequest, Message, UploadRequest } from './types';

/**
 * The message shape the API actually returns. The server persists ONE
 * clarification_request / upload_request jsonb column per message row (see
 * products/agent-platform/packages/api/routes/messages.ts and the
 * conversations schema), so history comes back with singular fields while the
 * client models them as per-round lists (see Message.clarificationRequests).
 */
type ServerMessage = Omit<Message, 'clarificationRequests' | 'uploadRequests'> & {
    clarificationRequest?: ClarificationRequest | null;
    uploadRequest?: UploadRequest | null;
    clarificationRequests?: ClarificationRequest[] | null;
    uploadRequests?: UploadRequest[] | null;
};

/**
 * Lifts the server's singular clarification/upload fields into the client's
 * list shape, so every reader downstream only ever deals with arrays. Applied
 * at the two places server message data enters the cache: the conversation-open
 * fetch (useChatPage) and the post-turn reconcile refetch (useChatStream).
 *
 * Already-normalized input passes through untouched, so running it twice (or
 * over a locally-built message) is a no-op. A singular field is preferred only
 * when no list is present, so a future server that sends lists wins outright.
 */
export function normalizeMessage(raw: Message): Message {
    const m = raw as ServerMessage;
    const clarificationRequests = m.clarificationRequests ?? (m.clarificationRequest ? [m.clarificationRequest] : undefined);
    const uploadRequests = m.uploadRequests ?? (m.uploadRequest ? [m.uploadRequest] : undefined);
    if (!m.clarificationRequest && !m.uploadRequest) {
        // Nothing legacy to strip — avoid allocating a copy per message on
        // every history load / reconcile.
        return raw;
    }
    const next = { ...m };
    delete next.clarificationRequest;
    delete next.uploadRequest;
    return {
        ...(next as Message),
        ...(clarificationRequests ? { clarificationRequests } : {}),
        ...(uploadRequests ? { uploadRequests } : {}),
    };
}

export function normalizeMessages(messages: Message[]): Message[] {
    return messages.map(normalizeMessage);
}

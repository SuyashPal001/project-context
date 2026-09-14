import type { Message } from './types';

type RequestKey = 'clarificationRequest' | 'generationConfirmRequest' | 'uploadRequest';

/**
 * The message currently blocking on a pending clarification / generation-confirm
 * / upload request, or undefined if nothing is blocking.
 *
 * This used to be `messages[messages.length - 1]?.xRequest?.status === 'pending'`.
 * That held only while every such request lived on its own placeholder message
 * pushed at the very end of the list. A clarification is now attached to the
 * assistant turn it interrupted (so its resolved card can render inline at the
 * point it was asked — see MessagePart), and that turn is not necessarily the
 * last row: a placeholder pushed later in the same turn can sit after it.
 *
 * Scanning back from the end and stopping at the newest message that carries
 * this kind of request keeps the old "a resolved request never blocks" semantics
 * — an older, never-resolved request can't keep the overlay up forever, because
 * only the newest one is consulted.
 *
 * The one case this genuinely can't see through is a request the *server* gave
 * up on: askClarifyingQuestions/requestUpload time out after 120s and flip their
 * DB row out of 'pending', but send no SSE event, so the client's copy stays
 * 'pending' and keeps the overlay up. No scan order fixes that — the client is
 * simply never told — so it wants a `clarification_expired` / `upload_expired`
 * event from the orchestrator rather than a heuristic here.
 */
export function findPendingRequestMessage(messages: Message[], key: RequestKey): Message | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const request = messages[i][key];
        if (request) return request.status === 'pending' ? messages[i] : undefined;
    }
    return undefined;
}

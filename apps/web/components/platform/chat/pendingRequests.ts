import type { ClarificationRequest, GenerationConfirmRequest, Message, UploadRequest } from './types';

export type RequestKind = 'clarification' | 'generationConfirm' | 'upload';

interface AnyRequest {
    id: string;
    status: 'pending' | string;
}

/**
 * Every request of this kind carried by the message, oldest round first.
 *
 * Clarification and upload requests are lists (a turn can ask several rounds —
 * see Message.clarificationRequests); generationConfirmRequest is still a
 * single object on its own placeholder message, so it is normalized to a
 * 0-or-1 element list here and the callers below stay identical for all three.
 */
export function requestsOfKind(message: Message, kind: RequestKind): AnyRequest[] {
    if (kind === 'clarification') return message.clarificationRequests ?? [];
    if (kind === 'upload') return message.uploadRequests ?? [];
    return message.generationConfirmRequest ? [message.generationConfirmRequest] : [];
}

/**
 * The request currently blocking the panel for this kind (plus the message it
 * hangs off), or undefined if nothing of this kind is blocking.
 *
 * This used to be `messages[messages.length - 1]?.xRequest?.status === 'pending'`.
 * That held only while every such request lived on its own placeholder message
 * pushed at the very end of the list. A clarification is now attached to the
 * assistant turn it interrupted (so its resolved card can render inline at the
 * point it was asked — see MessagePart), and that turn is not necessarily the
 * last row: a placeholder pushed later in the same turn can sit after it.
 *
 * Scanning back from the end and stopping at the newest message that CARRIES
 * this kind of request at all keeps the old "a resolved request never blocks"
 * semantics — an older, never-resolved request can't keep the overlay up
 * forever, because only the newest carrier is consulted. "Carries" means the
 * list is non-empty; "is blocking" means some entry in it is still pending. A
 * message holding three answered rounds and one pending fourth one blocks on
 * the fourth; one holding three answered rounds and nothing else does not
 * block, and the scan stops there rather than falling through to an older turn.
 *
 * The one case this genuinely can't see through is a request the *server* gave
 * up on: askClarifyingQuestions/requestUpload time out after 120s and flip their
 * DB row out of 'pending', but send no SSE event, so the client's copy stays
 * 'pending' and keeps the overlay up. No scan order fixes that — the client is
 * simply never told — so it wants a `clarification_expired` / `upload_expired`
 * event from the orchestrator rather than a heuristic here.
 */
function findPending(messages: Message[], kind: RequestKind): { message: Message; request: AnyRequest } | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const requests = requestsOfKind(messages[i], kind);
        if (requests.length === 0) continue;
        // Oldest-first: if several were somehow left pending on one message, the
        // one the user was asked first is the one to answer first.
        const pending = requests.find(r => r.status === 'pending');
        return pending ? { message: messages[i], request: pending } : undefined;
    }
    return undefined;
}

export function findPendingClarification(messages: Message[]): { message: Message; request: ClarificationRequest } | undefined {
    return findPending(messages, 'clarification') as { message: Message; request: ClarificationRequest } | undefined;
}

export function findPendingUpload(messages: Message[]): { message: Message; request: UploadRequest } | undefined {
    return findPending(messages, 'upload') as { message: Message; request: UploadRequest } | undefined;
}

export function findPendingGenerationConfirm(messages: Message[]): { message: Message; request: GenerationConfirmRequest } | undefined {
    return findPending(messages, 'generationConfirm') as { message: Message; request: GenerationConfirmRequest } | undefined;
}

import type { Attachment } from "@/types/agent-events";

const KEY = 'pc:pending-attachments';

// A staged payload is meant to be consumed by the next chat mount, moments later.
// Anything older was abandoned — a navigation the user backed out of, a tab left
// open — and must not attach itself to an unrelated conversation opened hours on.
const MAX_AGE_MS = 60_000;

interface Staged {
    at: number;
    attachments: Attachment[];
}

/**
 * Hand files from Drive to the chat composer across a route change.
 *
 * Not a URL param: creating the conversation redirects to `?id=…` and drops
 * everything else, and re-resolving ids through `GET /files` would miss any file
 * outside the current prefix/page. Not `window.__addComposeAttachment` either —
 * that bridge only exists while ChatInput is mounted, which it is not while the
 * user is still on Drive.
 */
export function stagePendingAttachments(attachments: Attachment[]): void {
    if (attachments.length === 0) return;
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), attachments } satisfies Staged));
    } catch {
        // Private mode or quota — the session just opens without them attached.
    }
}

/** Reads and clears the staged payload. Safe to call on every chat mount. */
export function consumePendingAttachments(): Attachment[] {
    try {
        const raw = sessionStorage.getItem(KEY);
        if (!raw) return [];
        sessionStorage.removeItem(KEY);
        const staged = JSON.parse(raw) as Staged;
        if (!staged?.attachments?.length) return [];
        if (Date.now() - staged.at > MAX_AGE_MS) return [];
        return staged.attachments;
    } catch {
        return [];
    }
}

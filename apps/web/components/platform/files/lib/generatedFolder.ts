import type { Conversation } from "@/components/platform/chat/types";

/** The orchestrator writes agent docs to generated/<conversationId>/<file>.md
 *  (apps/agent-orchestrator/src/persistence.ts) — so a folder directly under
 *  generated/ is named by the chat that produced it, not by a person. Returns
 *  that id, or null when the folder isn't one of these (a nested folder, or a
 *  tile anywhere else in Drive). */
export function generatedFolderConversationId(prefix: string, folderName: string): string | null {
    return prefix === 'generated/' ? folderName : null;
}

/** conversation.title || 'Untitled' for the chat that produced the folder, or
 *  null when no conversation matches (the chat was deleted) — callers fall
 *  back to the raw folder name (the id) rather than guessing a label. */
export function generatedFolderDisplayName(conversationId: string, conversations: Conversation[]): string | null {
    const match = conversations.find(c => c.id === conversationId);
    return match ? (match.title || 'Untitled') : null;
}

import type { Attachment } from "@/types/agent-events";
import {
    buildCreativeBriefMessage,
    mergeCreativeBriefAttachments,
} from "@/components/platform/chat/creative-library/creativeBrief";
import type { CreativeBrief } from "@/components/platform/chat/creative-library/creativeBriefModel";

export interface DraftComposerStart {
    message: string;
    attachments: Attachment[] | undefined;
    /**
     * Always undefined: starting a new draft-composer message must clear any
     * skillsUsed staged for a previous attempt (e.g. avatar creator's
     * "Create with AI", which sets pendingSkillsUsed before handleNewChat).
     * If that earlier handleNewChat failed, pendingSkillsUsed stayed set —
     * without this reset it would silently attach to the next typed message
     * instead.
     */
    pendingSkillsUsed: undefined;
}

/**
 * Pure computation behind startDraftComposerMessage (chat/page.tsx) — same
 * message/attachment merging as sendComposerMessage, plus the
 * pendingSkillsUsed reset. Split out so it's unit-testable without the
 * page's full hook tree.
 */
export function buildDraftComposerStart(
    text: string,
    attachments: Attachment[] | undefined,
    creativeBriefStarted: boolean,
    brief: CreativeBrief,
): DraftComposerStart {
    const message = creativeBriefStarted ? buildCreativeBriefMessage(text, brief) : text;
    const mergedAttachments = creativeBriefStarted ? mergeCreativeBriefAttachments(attachments, brief) : attachments;
    return { message, attachments: mergedAttachments, pendingSkillsUsed: undefined };
}

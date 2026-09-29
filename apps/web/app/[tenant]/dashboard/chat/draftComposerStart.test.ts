import { describe, it, expect } from "vitest";
import { createEmptyCreativeBrief } from "@/components/platform/chat/creative-library/creativeBriefModel";
import { buildDraftComposerStart } from "./draftComposerStart";

describe("buildDraftComposerStart", () => {
    it("always clears pendingSkillsUsed, so a skill staged for a prior failed handleNewChat can't leak onto the next typed draft message", () => {
        const result = buildDraftComposerStart("hello", undefined, false, createEmptyCreativeBrief());
        expect(result.pendingSkillsUsed).toBeUndefined();
    });

    it("passes the plain text/attachments through when no creative brief is started", () => {
        const result = buildDraftComposerStart("hello", [{ fileId: "f1" } as never], false, createEmptyCreativeBrief());
        expect(result.message).toBe("hello");
        expect(result.attachments).toEqual([{ fileId: "f1" }]);
        expect(result.pendingSkillsUsed).toBeUndefined();
    });
});

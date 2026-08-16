import { describe, it, expect } from "vitest";
import { reducePersonaAnimationState } from "../usePersonaAnimationState";

describe("reducePersonaAnimationState", () => {
    it("starts idle and moves to running on tool_call", () => {
        expect(reducePersonaAnimationState("idle", "tool_call")).toBe("running");
    });

    it("moves to thinking on tool_done", () => {
        expect(reducePersonaAnimationState("running", "tool_done")).toBe("thinking");
    });

    it("moves to responding on delta", () => {
        expect(reducePersonaAnimationState("thinking", "delta")).toBe("responding");
    });

    it("moves to waiting on approval_request", () => {
        expect(reducePersonaAnimationState("responding", "approval_request")).toBe("waiting");
    });

    it("moves to review on artifact_ready", () => {
        expect(reducePersonaAnimationState("responding", "artifact_ready")).toBe("review");
    });

    it("moves to done on done", () => {
        expect(reducePersonaAnimationState("responding", "done")).toBe("done");
    });

    it("moves to failed on error", () => {
        expect(reducePersonaAnimationState("thinking", "error")).toBe("failed");
    });

    it("returns the current state for an unrecognized event", () => {
        // @ts-expect-error — exercising the default branch with a value outside ChatStreamEventType
        expect(reducePersonaAnimationState("idle", "unknown_event")).toBe("idle");
    });
});

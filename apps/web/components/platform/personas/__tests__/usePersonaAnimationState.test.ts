import { describe, it, expect } from "vitest";
import { reducePersonaAnimationState } from "../usePersonaAnimationState";

describe("reducePersonaAnimationState", () => {
    it("starts idle and moves to thinking on tool_call", () => {
        expect(reducePersonaAnimationState("idle", "tool_call")).toBe("thinking");
    });

    it("moves to responding on delta", () => {
        expect(reducePersonaAnimationState("thinking", "delta")).toBe("responding");
    });

    it("returns to thinking after tool_done (agent still reasoning, not yet streaming)", () => {
        expect(reducePersonaAnimationState("responding", "tool_done")).toBe("thinking");
    });

    it("returns to idle on done", () => {
        expect(reducePersonaAnimationState("responding", "done")).toBe("idle");
    });

    it("returns to idle on error", () => {
        expect(reducePersonaAnimationState("thinking", "error")).toBe("idle");
    });
});

import { useReducer } from "react";

export type PersonaAnimationState =
    | "idle" | "waving" | "running" | "thinking" | "responding"
    | "waiting" | "review" | "done" | "failed";

export type ChatStreamEventType =
    | "tool_call" | "tool_done" | "delta" | "done" | "error"
    | "approval_request" | "artifact_ready" | "reasoning";

export function reducePersonaAnimationState(
    _current: PersonaAnimationState,
    event: ChatStreamEventType,
): PersonaAnimationState {
    switch (event) {
        case "tool_call":
            return "running";
        case "reasoning":
            return "thinking";
        case "tool_done":
            return "thinking";
        case "delta":
            return "responding";
        case "approval_request":
            return "waiting";
        case "artifact_ready":
            return "review";
        case "done":
            return "done";
        case "error":
            return "failed";
        default:
            return _current;
    }
}

export function usePersonaAnimationState() {
    const [state, dispatch] = useReducer(reducePersonaAnimationState, "idle");
    return { state, onStreamEvent: dispatch };
}

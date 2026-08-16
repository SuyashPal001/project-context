import { useReducer } from "react";

export type PersonaAnimationState = "idle" | "thinking" | "responding";
export type ChatStreamEventType = "tool_call" | "tool_done" | "delta" | "done" | "error";

export function reducePersonaAnimationState(
    _current: PersonaAnimationState,
    event: ChatStreamEventType,
): PersonaAnimationState {
    switch (event) {
        case "tool_call":
            return "thinking";
        case "delta":
            return "responding";
        case "tool_done":
            return "thinking";
        case "done":
        case "error":
            return "idle";
        default:
            return _current;
    }
}

export function usePersonaAnimationState() {
    const [state, dispatch] = useReducer(reducePersonaAnimationState, "idle");
    return { state, onStreamEvent: dispatch };
}

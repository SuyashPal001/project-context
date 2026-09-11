import type { Agent, AgentOrigin } from "./types";

// agents.origin is the stored, authoritative signal for who put this agent on
// the tenant — set explicitly at creation time (onboarding.ts, agents.crud.ts)
// rather than inferred here from isDefault/persona, so it can't drift from
// what the row actually is.
const AGENT_ORIGIN_LABELS: Record<AgentOrigin, string> = {
    built_in: "Built-in",
    official: "Official",
    custom: "Custom",
};

export function getAgentOriginLabel(agent: Pick<Agent, "origin">): string {
    return AGENT_ORIGIN_LABELS[agent.origin] ?? "Custom";
}

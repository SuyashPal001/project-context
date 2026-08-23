/**
 * Shared with the agent detail page's "About this agent" section
 * (AgentSkillSection.tsx) and AgentCard — one source so the description
 * shown on the card and the detail page can't drift apart.
 */
export function isSupervisor(name: string): boolean {
    const n = name.toLowerCase();
    return n.includes("pm") || (n.includes("product") && !n.includes("prd"));
}

export function fallbackAgentDescription(name: string): string {
    const n = name.toLowerCase();
    if (isSupervisor(n)) {
        return "Orchestrates the full PM lifecycle — writes PRDs, generates roadmaps, and breaks milestones into engineering tasks by delegating to specialist agents. Use this when you want to plan and ship a feature end-to-end.";
    }
    if (n.includes("prd")) {
        return "Specialist agent for writing and refining Product Requirements Documents. Saves PRDs to your workspace so the roadmap agent can pick them up.";
    }
    if (n.includes("roadmap")) {
        return "Generates structured roadmaps with milestones from an approved PRD. Use after your PRD is ready.";
    }
    if (n.includes("task")) {
        return "Breaks approved milestones into concrete engineering tasks with acceptance criteria, priorities, and effort estimates.";
    }
    if (n.includes("architect")) {
        return "Technical architect with deep codebase knowledge. Reviews designs, proposes system architecture, and answers implementation questions.";
    }
    return "A general-purpose AI agent. Chat with it to search the web, analyse documents, and get work done.";
}

export function agentDescription(name: string, description?: string | null): string {
    return description?.trim() ? description : fallbackAgentDescription(name);
}

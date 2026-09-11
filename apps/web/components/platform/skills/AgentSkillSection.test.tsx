/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
    api: { get: vi.fn(async () => ({ data: [{ id: "row-1", name: "ugc-ads-production" }] })) },
}));
const detachSkillFromAgent = vi.fn(async () => undefined);
vi.mock("@/components/platform/skills/actions", () => ({
    detachSkillFromAgent: (...args: unknown[]) => detachSkillFromAgent(...(args as [])),
}));
vi.mock("@/components/platform/skills/AttachSkillPicker", () => ({ AttachSkillPicker: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { AgentSkillSection } from "@/app/[tenant]/dashboard/agents/[agentId]/AgentSkillSection";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderSection() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <AgentSkillSection agentId="agent-1" isOwner brandingEnabled={false} tenantSlug="t" agent={undefined} isLoading={false} />
        </QueryClientProvider>,
    );
}

describe("AgentSkillSection", () => {
    it("lists the skills attached to the agent", async () => {
        renderSection();
        await waitFor(() => expect(screen.getByText("ugc-ads-production")).toBeTruthy());
    });

    it("detaches a skill by its row id", async () => {
        renderSection();
        await waitFor(() => screen.getByText("ugc-ads-production"));
        await userEvent.click(screen.getByRole("button", { name: /detach ugc-ads-production/i }));
        await waitFor(() => expect(detachSkillFromAgent).toHaveBeenCalledWith("agent-1", "row-1"));
    });
});

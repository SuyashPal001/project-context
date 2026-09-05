import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => {
    class ApiError extends Error {
        constructor(public status: number, public data: unknown) {
            super(`API Error: ${status}`);
            this.name = "ApiError";
        }
    }
    return {
        ApiError,
        api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    };
});

import { api, ApiError } from "@/lib/api";
import { attachSkillToAgent, createSkillFromBody, resolveDefaultAgent, startSkillTestChat } from "./actions";
import type { Skill } from "./types";
import type { Agent } from "@/components/platform/agents/types";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: "22222222-2222-4222-8222-222222222222",
        name: "PDF Tools",
        slug: "pdf-tools-abc123",
        description: "Work with PDFs",
        visibility: "public",
        isOfficial: false,
        latestVersion: 2,
        ownerTenantId: "tenant-1",
        ownerName: "Ada Lovelace",
        ownerEmail: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        installId: "11111111-1111-4111-8111-111111111111",
        installedVersion: 2,
        installed: true,
        latestVersionStatus: "ready",
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        ...overrides,
    };
}

describe("attachSkillToAgent", () => {
    beforeEach(() => vi.clearAllMocks());

    it("posts name and installId only — never a client-side systemPrompt", async () => {
        vi.mocked(api.post).mockResolvedValueOnce({});
        await attachSkillToAgent("agent-1", makeSkill());
        expect(api.post).toHaveBeenCalledWith("/api/v1/agents/agent-1/skills", {
            name: "PDF Tools",
            installId: "11111111-1111-4111-8111-111111111111",
        });
    });

    it("throws NO_INSTALL_ID when the skill has no install row", async () => {
        await expect(attachSkillToAgent("agent-1", makeSkill({ installId: null }))).rejects.toThrow("NO_INSTALL_ID");
        expect(api.post).not.toHaveBeenCalled();
    });

    it("treats a 409 CONFLICT as success — the skill is already attached at that version", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new ApiError(409, { code: "CONFLICT" }));
        await expect(attachSkillToAgent("agent-1", makeSkill())).resolves.toBeUndefined();
    });

    it("rethrows a 409 NOT_READY — nothing was attached, caller must surface this", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new ApiError(409, { code: "NOT_READY" }));
        await expect(attachSkillToAgent("agent-1", makeSkill())).rejects.toBeInstanceOf(ApiError);
    });

    it("rethrows any other API failure", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new ApiError(500, { code: "INTERNAL_ERROR" }));
        await expect(attachSkillToAgent("agent-1", makeSkill())).rejects.toBeInstanceOf(ApiError);
    });
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
    return {
        id: "agent-1",
        tenantId: "tenant-1",
        name: "Research Engineer",
        type: "custom",
        status: "active",
        model: null,
        llmProviderId: null,
        isInternal: false,
        isDefault: false,
        description: null,
        persona: null,
        avatarUrl: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("resolveDefaultAgent", () => {
    it("prefers the isDefault agent among active agents", () => {
        const flagged = makeAgent({ id: "agent-2", isDefault: true });
        expect(resolveDefaultAgent([makeAgent(), flagged])?.id).toBe("agent-2");
    });

    it("falls back to the first active agent when none is flagged", () => {
        expect(resolveDefaultAgent([makeAgent(), makeAgent({ id: "agent-2" })])?.id).toBe("agent-1");
    });

    it("ignores non-active agents", () => {
        expect(resolveDefaultAgent([makeAgent({ status: "retired", isDefault: true }), makeAgent({ id: "agent-2" })])?.id).toBe("agent-2");
    });

    it("returns null when there is no active agent", () => {
        expect(resolveDefaultAgent([makeAgent({ status: "paused" })])).toBeNull();
    });
});

describe("startSkillTestChat", () => {
    beforeEach(() => vi.clearAllMocks());

    it("creates a conversation with the default agent then attaches the skill", async () => {
        vi.mocked(api.post)
            .mockResolvedValueOnce({ data: { id: "conv-1" } })
            .mockResolvedValueOnce({});

        const result = await startSkillTestChat(makeSkill(), [makeAgent()]);

        expect(result).toEqual({ conversationId: "conv-1", agentId: "agent-1" });
        expect(api.post).toHaveBeenNthCalledWith(1, "/api/v1/conversations", { agentId: "agent-1" });
        expect(api.post).toHaveBeenNthCalledWith(2, "/api/v1/agents/agent-1/skills", {
            name: "PDF Tools",
            installId: "11111111-1111-4111-8111-111111111111",
        });
    });

    it("throws NO_ACTIVE_AGENTS without creating a conversation", async () => {
        await expect(startSkillTestChat(makeSkill(), [])).rejects.toThrow("NO_ACTIVE_AGENTS");
        expect(api.post).not.toHaveBeenCalled();
    });
});

describe("createSkillFromBody", () => {
    beforeEach(() => vi.clearAllMocks());

    it("posts an authored source with the generated body", async () => {
        vi.mocked(api.post).mockResolvedValueOnce({});
        await createSkillFromBody("Bid Writer", "Writes bids", "---\nname: bid-writer\ndescription: d\n---\n\nBody.");

        expect(api.post).toHaveBeenCalledWith("/api/v1/skills", {
            name: "Bid Writer",
            description: "Writes bids",
            source: { type: "authored", body: "---\nname: bid-writer\ndescription: d\n---\n\nBody." },
        });
    });
});

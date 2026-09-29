import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

import { api } from "@/lib/api";
import { toast } from "sonner";
import { startOfficialSkill } from "./startOfficialSkill";
import type { Skill } from "./types";

function makeSkill(
    overrides: Partial<Pick<Skill, "id" | "name" | "showcase">> = {},
): Pick<Skill, "id" | "name" | "showcase"> {
    return {
        id: "skill-1",
        name: "Avatar Creator",
        showcase: {
            imageUrl: "/creative/avatars/beginner-fitness-instructor.jpg",
            bestFor: ["Fitness coaches"],
            starterPrompt: "Create an avatar for my fitness brand",
        },
        ...overrides,
    };
}

describe("startOfficialSkill", () => {
    beforeEach(() => vi.clearAllMocks());

    it("installs then navigates with the starter prompt, skill id and name", async () => {
        vi.mocked(api.post).mockResolvedValueOnce(undefined);
        const push = vi.fn();

        await startOfficialSkill(makeSkill(), "acme", { push });

        expect(api.post).toHaveBeenCalledWith("/api/v1/skills/skill-1/install");
        expect(push).toHaveBeenCalledWith(
            "/acme/dashboard/chat?prompt=Create%20an%20avatar%20for%20my%20fitness%20brand&skill=skill-1&skillName=Avatar%20Creator",
        );
    });

    it("falls back to a generic prompt when showcase has none", async () => {
        vi.mocked(api.post).mockResolvedValueOnce(undefined);
        const push = vi.fn();

        await startOfficialSkill(makeSkill({ showcase: null }), "acme", { push });

        expect(push).toHaveBeenCalledWith(
            "/acme/dashboard/chat?prompt=Use%20the%20Avatar%20Creator%20skill&skill=skill-1&skillName=Avatar%20Creator",
        );
    });

    it("installs every time, so Start always moves the tenant's install to the latest version", async () => {
        vi.mocked(api.post).mockResolvedValueOnce(undefined);
        const push = vi.fn();

        await startOfficialSkill(makeSkill(), "acme", { push });

        expect(api.post).toHaveBeenCalledTimes(1);
        expect(api.post).toHaveBeenCalledWith("/api/v1/skills/skill-1/install");
    });

    it("shows a toast and does not navigate when install fails", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new Error("boom"));
        const push = vi.fn();

        await startOfficialSkill(makeSkill(), "acme", { push });

        expect(toast.error).toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });
});

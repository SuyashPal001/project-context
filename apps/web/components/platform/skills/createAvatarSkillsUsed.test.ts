import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
    api: { post: vi.fn() },
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn() },
}));

import { api } from "@/lib/api";
import { toast } from "sonner";
import { resolveCreateAvatarSkillsUsed } from "./createAvatarSkillsUsed";

describe("resolveCreateAvatarSkillsUsed", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns undefined (today's plain-send behaviour) when the Official skill isn't seeded", async () => {
        const result = await resolveCreateAvatarSkillsUsed(undefined);

        expect(result).toBeUndefined();
        expect(api.post).not.toHaveBeenCalled();
    });

    it("installs the skill and returns skillsUsed when it is found", async () => {
        vi.mocked(api.post).mockResolvedValueOnce(undefined);

        const result = await resolveCreateAvatarSkillsUsed({ id: "skill-1", name: "Avatar Creator" });

        expect(api.post).toHaveBeenCalledWith("/api/v1/skills/skill-1/install");
        expect(result).toEqual([{ id: "skill-1", name: "Avatar Creator" }]);
    });

    it("installs every time, so it always moves the tenant's install to the latest version", async () => {
        vi.mocked(api.post).mockResolvedValueOnce(undefined);

        await resolveCreateAvatarSkillsUsed({ id: "skill-1", name: "Avatar Creator" });

        expect(api.post).toHaveBeenCalledTimes(1);
    });

    it("returns null and toasts when install fails, so the caller aborts without sending", async () => {
        vi.mocked(api.post).mockRejectedValueOnce(new Error("boom"));

        const result = await resolveCreateAvatarSkillsUsed({ id: "skill-1", name: "Avatar Creator" });

        expect(result).toBeNull();
        expect(toast.error).toHaveBeenCalled();
    });
});

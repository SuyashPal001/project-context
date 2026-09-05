import { api, ApiError } from "@/lib/api";
import type { Skill, SkillFile, SkillTab, SkillsResponse } from "./types";
import type { Agent } from "@/components/platform/agents/types";

export async function listSkills(tab: SkillTab): Promise<Skill[]> {
    const res = await api.get<SkillsResponse>(`/api/v1/skills?tab=${tab}`);
    return res.data;
}

export async function getSkill(skillId: string): Promise<Skill> {
    const res = await api.get<{ data: Skill }>(`/api/v1/skills/${skillId}`);
    return res.data;
}

// ─── Package import — parked ──────────────────────────────────────────────
// getUploadUrl through createSkillFromUrl, and ImportSkillDialog alongside
// them, have no caller: importing a pre-built package is a developer action
// and belongs in the dev studio, not on the tenant Skills page. The backend
// routes and the import worker are all live and tested — this is UI that's
// waiting for a home, not dead code to delete.
async function getUploadUrl(fileName: string): Promise<{ uploadUrl: string; fileKey: string }> {
    return api.post<{ uploadUrl: string; fileKey: string }>("/api/v1/skills/upload-url", { fileName });
}

async function uploadZipToS3(uploadUrl: string, file: File): Promise<void> {
    const res = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": "application/zip" } });
    if (!res.ok) throw new Error(`Upload failed with status ${res.status}`);
}

export async function createSkillFromZip(name: string, description: string, file: File): Promise<void> {
    const { uploadUrl, fileKey } = await getUploadUrl(file.name);
    await uploadZipToS3(uploadUrl, file);
    await api.post("/api/v1/skills", { name, description, source: { type: "zip", fileKey } });
}

export async function createSkillFromGithub(name: string, description: string, owner: string, repo: string, ref: string): Promise<void> {
    await api.post("/api/v1/skills", { name, description, source: { type: "github", owner, repo, ref } });
}

export async function createSkillFromUrl(name: string, description: string, url: string): Promise<void> {
    await api.post("/api/v1/skills", { name, description, source: { type: "url", url } });
}

/**
 * Creates a skill from a SKILL.md body written in the app (see
 * CreateSkillDialog). The server treats it as an 'authored' source and runs it
 * through the same import worker a zip goes through, so it lands `pending` and
 * flips to `ready` a moment later — the page already polls for that.
 */
export async function createSkillFromBody(name: string, description: string, body: string): Promise<void> {
    await api.post("/api/v1/skills", { name, description, source: { type: "authored", body } });
}

export async function publishSkill(skillId: string): Promise<void> {
    await api.post(`/api/v1/skills/${skillId}/publish`);
}

export async function installSkill(skillId: string): Promise<void> {
    await api.post(`/api/v1/skills/${skillId}/install`);
}

export async function uninstallSkill(skillId: string): Promise<void> {
    await api.del(`/api/v1/skills/${skillId}/install`);
}

export async function listSkillFiles(skillId: string): Promise<SkillFile[]> {
    const res = await api.get<{ data: SkillFile[] }>(`/api/v1/skills/${skillId}/files`);
    return res.data;
}

export async function getSkillFileUrl(skillId: string, path: string): Promise<string> {
    const res = await api.get<{ downloadUrl: string }>(`/api/v1/skills/${skillId}/files/download-url?path=${encodeURIComponent(path)}`);
    return res.downloadUrl;
}

/**
 * Attaches an installed skill to an agent. The system prompt is NOT sent — the
 * server derives it from the pinned skill_versions manifest body, so it can't be
 * spoofed or go stale. A 409 means the same skill+version is already attached,
 * which is the desired end state, so it resolves rather than throwing.
 */
export async function attachSkillToAgent(agentId: string, skill: Skill): Promise<void> {
    if (!skill.installId) throw new Error("NO_INSTALL_ID");
    try {
        await api.post(`/api/v1/agents/${agentId}/skills`, {
            name: skill.name,
            installId: skill.installId,
        });
    } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
            const code = (err.data as { code?: string } | undefined)?.code;
            if (code === "CONFLICT") return; // already attached at this version — desired end state
            throw err; // e.g. NOT_READY — nothing was attached, caller must surface this
        }
        throw err;
    }
}

/**
 * Deliberately identical to useChatPage.ts's New Chat fallback:
 * `activeAgents.find(a => a.isDefault) ?? activeAgents[0]`. agents.isDefault is
 * effectively a dead column (never written), so in practice this resolves to
 * the earliest-created active agent. Reused rather than replaced so Test-in-chat
 * lands the user on the same agent New Chat would.
 */
export function resolveDefaultAgent(agents: Agent[]): Agent | null {
    const active = agents.filter((a) => a.status === "active");
    return active.find((a) => a.isDefault) ?? active[0] ?? null;
}

/**
 * Opens a fresh conversation on the tenant's default agent with this skill
 * attached. The attach carries the real SKILL.md body (derived server-side), so
 * the agent's behavior in that conversation genuinely reflects the skill.
 * Throws Error("NO_ACTIVE_AGENTS") when the tenant has none.
 */
export async function startSkillTestChat(
    skill: Skill,
    agents: Agent[],
): Promise<{ conversationId: string; agentId: string }> {
    const agent = resolveDefaultAgent(agents);
    if (!agent) throw new Error("NO_ACTIVE_AGENTS");

    const conversation = await api.post<{ data: { id: string } }>("/api/v1/conversations", { agentId: agent.id });
    await attachSkillToAgent(agent.id, skill);
    return { conversationId: conversation.data.id, agentId: agent.id };
}

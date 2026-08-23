import { api } from "@/lib/api";
import type { Skill, SkillTab, SkillsResponse } from "./types";

export async function listSkills(tab: SkillTab): Promise<Skill[]> {
    const res = await api.get<SkillsResponse>(`/api/v1/skills?tab=${tab}`);
    return res.data;
}

export async function getSkill(skillId: string): Promise<Skill> {
    const res = await api.get<{ data: Skill }>(`/api/v1/skills/${skillId}`);
    return res.data;
}

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

export async function publishSkill(skillId: string): Promise<void> {
    await api.post(`/api/v1/skills/${skillId}/publish`);
}

export async function installSkill(skillId: string): Promise<void> {
    await api.post(`/api/v1/skills/${skillId}/install`);
}

export async function uninstallSkill(skillId: string): Promise<void> {
    await api.del(`/api/v1/skills/${skillId}/install`);
}

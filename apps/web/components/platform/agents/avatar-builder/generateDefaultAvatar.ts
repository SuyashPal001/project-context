import { api } from '@/lib/api';
import { randomizeAvatarParams } from './avatarParams';
import { buildAvatarSvg } from './buildAvatarSvg';
import { saveAvatarAsset } from './saveAvatarAsset';

// Fired once, right after agent creation, so a new agent never starts out with
// nothing but the generic fallback icon. Reuses the exact same pipeline as the
// avatar builder's own "Roll Random" + "Use This Avatar" so a generated default
// is a real, saved, editable avatar from day one — not a client-only fallback.
export async function generateDefaultAvatar(agentId: string, agentName: string): Promise<void> {
    const params = randomizeAvatarParams();
    const svg = buildAvatarSvg(params);
    const filename = `${agentName.toLowerCase().replace(/\s+/g, "_") || "agent"}_avatar.svg`;
    const { fileId } = await saveAvatarAsset(svg, filename);
    await api.patch(`/api/v1/agents/${agentId}`, { avatarFileId: fileId, avatarParams: params });
}

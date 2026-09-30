import { api } from '@/lib/api';
import type { AvatarSelection } from './creativeBriefModel';

/** A tenant's own avatar — a creative_library_assets row with tenant_id set,
 *  backed by an image in Drive's Avatars folder. Platform presets are not
 *  here; they stay in creativeLibraryAvatars.ts. */
export interface TenantAvatar {
    id: string;
    fileId: string;
    name: string;
    role: string | null;
    tone: string | null;
    namingStatus: 'pending' | 'done' | 'failed';
    category?: 'UGC' | 'Animation' | 'TVC' | null;
    type: string;
    size: number;
    createdAt: string;
}

export const TENANT_AVATARS_QUERY_KEY = ['tenant-avatars'] as const;

export async function listTenantAvatars(): Promise<TenantAvatar[]> {
    return (await api.get<{ data: TenantAvatar[] }>('/api/v1/creative-library-assets/avatars')).data;
}

/** Registers a just-uploaded Avatars-folder image and names it (within the request's budget). */
export async function createTenantAvatar(fileId: string): Promise<TenantAvatar> {
    return (await api.post<{ data: TenantAvatar }>('/api/v1/creative-library-assets/avatars', { fileId })).data;
}

export async function describeTenantAvatar(id: string): Promise<TenantAvatar> {
    return (await api.post<{ data: TenantAvatar }>(`/api/v1/creative-library-assets/avatars/${id}/describe`)).data;
}

export function tenantAvatarSelection(avatar: TenantAvatar): AvatarSelection {
    return {
        kind: 'avatar', id: `custom:${avatar.fileId}`, name: avatar.name,
        role: avatar.role ?? 'Your avatar', tone: avatar.tone ?? 'Custom', ...(avatar.category ? { category: avatar.category } : {}),
        attachment: { fileId: avatar.fileId, name: avatar.name, type: avatar.type, size: avatar.size },
    };
}

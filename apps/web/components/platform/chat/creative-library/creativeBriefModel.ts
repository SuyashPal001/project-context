import type { Attachment } from '@/types/agent-events';

export type CreativeLibraryTab = 'templates' | 'avatars' | 'products' | 'audio';

export interface TemplateSelection {
    kind: 'template';
    id: string;
    title: string;
    category: string;
    image: string;
}

export interface AvatarSelection {
    kind: 'avatar';
    id: string;
    name: string;
    role: string;
    tone: string;
    image?: string;
    attachment: Attachment;
}

export interface ProductImageSelection {
    kind: 'product-image';
    id: string;
    name: string;
    attachment: Attachment;
}

export interface ProductUrlSelection {
    kind: 'product-url';
    id: string;
    name: string;
    url: string;
}

export type ProductSelection = ProductImageSelection | ProductUrlSelection;

export interface VoiceSelection {
    kind: 'voice';
    id: string;
    name: string;
    tagline?: string;
    language: string;
    languageLabel: string;
}

export interface CreativeBrief {
    template: TemplateSelection | null;
    avatar: AvatarSelection | null;
    product: ProductSelection | null;
    voice: VoiceSelection | null;
}

export type CreativeSelection = TemplateSelection | AvatarSelection | ProductSelection | VoiceSelection;
export type CreativeBriefField = keyof CreativeBrief;

export const CREATIVE_BRIEF_FIELDS: readonly CreativeBriefField[] = ['template', 'avatar', 'product', 'voice'];

export function createEmptyCreativeBrief(): CreativeBrief {
    return { template: null, avatar: null, product: null, voice: null };
}

export function selectionField(selection: CreativeSelection): CreativeBriefField {
    if (selection.kind === 'template') return 'template';
    if (selection.kind === 'avatar') return 'avatar';
    if (selection.kind === 'voice') return 'voice';
    return 'product';
}

export function updateCreativeBrief(brief: CreativeBrief, selection: CreativeSelection): CreativeBrief {
    return { ...brief, [selectionField(selection)]: selection };
}

export function fieldForTab(tab: CreativeLibraryTab): CreativeBriefField {
    if (tab === 'templates') return 'template';
    if (tab === 'avatars') return 'avatar';
    if (tab === 'audio') return 'voice';
    return 'product';
}

export function tabForField(field: CreativeBriefField): CreativeLibraryTab {
    if (field === 'template') return 'templates';
    if (field === 'avatar') return 'avatars';
    if (field === 'voice') return 'audio';
    return 'products';
}

export function isCreativeBriefStarted(brief: CreativeBrief): boolean {
    return CREATIVE_BRIEF_FIELDS.some(field => brief[field] !== null);
}

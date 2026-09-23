import type { Attachment } from '@/types/agent-events';
import {
    CREATIVE_BRIEF_FIELDS,
    createEmptyCreativeBrief,
    type CreativeBrief,
    type CreativeSelection,
} from './creativeBriefModel';

const CREATIVE_BRIEF_UI_PREFIX = '<!-- olmo-creative-brief:v1:';
const CREATIVE_BRIEF_UI_SUFFIX = ' -->';

export interface CreativeBriefPresentation {
    direction: string;
    brief: CreativeBrief;
}

export function creativeSelectionLabel(selection: CreativeSelection): string {
    if (selection.kind === 'template') return selection.title;
    if (selection.kind === 'avatar') return selection.name;
    if (selection.kind === 'voice') return `${selection.name} · ${selection.languageLabel}`;
    return selection.name;
}

function selectedImportedImage(brief: CreativeBrief): Attachment | undefined {
    if (brief.product?.kind !== 'product-url') return undefined;
    const { imported } = brief.product;
    if (!imported?.selectedImageId) return undefined;
    if (!Array.isArray(imported.images)) return undefined;
    return imported.images.find(image => image.fileId === imported.selectedImageId);
}

export function buildCreativeBriefMessage(direction: string, brief: CreativeBrief): string {
    const trimmedDirection = direction.trim();
    const productSelection = brief.product;
    let product: string | undefined;
    if (productSelection?.kind === 'product-url') {
        const imported = productSelection.imported;
        // Lead with the (possibly user-edited) imported title so it appears once
        // and a corrected title replaces the stale scraped name.
        const lead = imported ? (imported.title?.trim() || productSelection.name) : productSelection.name;
        product = [`${lead} (${productSelection.url})`, imported?.description, imported?.price]
            .filter(Boolean)
            .join(' — ');
    } else {
        product = productSelection?.name;
    }
    // "Has an image actually attached" must match mergeCreativeBriefAttachments's
    // own condition below, or this line can claim an attachment that was never
    // added to the outgoing message.
    const hasSelectedImage = productSelection?.kind === 'product-image' || Boolean(selectedImportedImage(brief));
    const lines = [
        trimmedDirection ? `User direction:\n${trimmedDirection}` : null,
        'Creative brief:',
        brief.template ? `- Template: ${brief.template.title} (${brief.template.category})\n  Template slug: ${brief.template.id}` : null,
        brief.avatar ? `- Avatar: ${brief.avatar.name} · ${brief.avatar.role} · ${brief.avatar.tone}\n  Use the attached still image as the presenter reference.` : null,
        product ? `- Product: ${product}${hasSelectedImage ? '\n  Use the attached product image as the visual reference.' : '\n  Treat the URL as a source to inspect; verify product details before making claims.'}` : null,
        brief.voice ? `- Voice: ${brief.voice.name}${brief.voice.tagline ? ` · ${brief.voice.tagline}` : ''}\n  Voice ID: ${brief.voice.id}\n  Narration language: ${brief.voice.languageLabel} (${brief.voice.language})` : null,
        'Create the ad from this brief. Do not invent product claims, prices, customer quotes, or results.',
    ];
    const agentBrief = lines.filter((line): line is string => Boolean(line)).join('\n');
    // This durable annotation lets the transcript render the user's concise
    // direction and visual selections after the server refetches the message.
    // Hyphens are encoded explicitly so arbitrary user text cannot terminate
    // the HTML comment early with "-->."
    const presentation = encodeURIComponent(JSON.stringify({ direction: trimmedDirection, brief })).replaceAll('-', '%2D');
    return `${agentBrief}\n\n${CREATIVE_BRIEF_UI_PREFIX}${presentation}${CREATIVE_BRIEF_UI_SUFFIX}`;
}

export function parseCreativeBriefPresentation(content: string): CreativeBriefPresentation | null {
    const markerStart = content.lastIndexOf(CREATIVE_BRIEF_UI_PREFIX);
    if (markerStart < 0 || !content.endsWith(CREATIVE_BRIEF_UI_SUFFIX)) return null;
    const encoded = content.slice(markerStart + CREATIVE_BRIEF_UI_PREFIX.length, -CREATIVE_BRIEF_UI_SUFFIX.length);
    try {
        const value: unknown = JSON.parse(decodeURIComponent(encoded));
        if (!isRecord(value) || typeof value.direction !== 'string' || !isRecord(value.brief)) return null;
        const brief = parseCreativeBriefDraft(JSON.stringify(value.brief));
        if (!CREATIVE_BRIEF_FIELDS.some(field => brief[field] !== null)) return null;
        return { direction: value.direction, brief };
    } catch {
        return null;
    }
}

export function creativeMessageDisplayText(content: string): string {
    const presentation = parseCreativeBriefPresentation(content);
    if (presentation) {
        if (presentation.direction) return presentation.direction;
        return CREATIVE_BRIEF_FIELDS.flatMap(field => {
            const selection = presentation.brief[field];
            return selection ? [creativeSelectionLabel(selection)] : [];
        }).join(' · ');
    }
    return content;
}

export function creativeBriefAttachmentIds(brief: CreativeBrief): Set<string> {
    return new Set([
        brief.avatar?.attachment.fileId,
        brief.product?.kind === 'product-image' ? brief.product.attachment.fileId : undefined,
        selectedImportedImage(brief)?.fileId,
    ].filter((fileId): fileId is string => Boolean(fileId)));
}

export function mergeCreativeBriefAttachments(existing: Attachment[] | undefined, brief: CreativeBrief): Attachment[] | undefined {
    const candidates = [
        ...(existing ?? []),
        brief.avatar?.attachment,
        brief.product?.kind === 'product-image' ? brief.product.attachment : undefined,
        selectedImportedImage(brief),
    ].filter((attachment): attachment is Attachment => Boolean(attachment));
    const unique = [...new Map(candidates.map(attachment => [attachment.fileId, attachment])).values()];
    return unique.length > 0 ? unique : undefined;
}

export function countCreativeBriefAttachments(existing: Attachment[] | undefined, brief: CreativeBrief, pendingAudio: boolean): number {
    return (mergeCreativeBriefAttachments(existing, brief)?.length ?? 0) + (pendingAudio ? 1 : 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
    return typeof value[key] === 'string' && value[key].length > 0;
}

function isTrustedCreativeImage(value: unknown): value is string {
    return typeof value === 'string'
        && /^\/creative\/[a-zA-Z0-9/_-]+\.(?:png|jpe?g|webp)$/.test(value);
}

function isAttachment(value: unknown): value is Attachment {
    return isRecord(value) && hasString(value, 'fileId') && hasString(value, 'name') && hasString(value, 'type');
}

function isTemplateSelection(value: unknown): value is NonNullable<CreativeBrief['template']> {
    return isRecord(value) && value.kind === 'template' && hasString(value, 'id') && hasString(value, 'title')
        && hasString(value, 'category') && isTrustedCreativeImage(value.image);
}

function isAvatarSelection(value: unknown): value is NonNullable<CreativeBrief['avatar']> {
    return isRecord(value) && value.kind === 'avatar' && hasString(value, 'id') && hasString(value, 'name')
        && hasString(value, 'role') && hasString(value, 'tone') && isAttachment(value.attachment)
        && (value.image === undefined || isTrustedCreativeImage(value.image));
}

function isStringOrNull(value: unknown): boolean {
    return value === null || typeof value === 'string';
}

function isImportedProductData(value: unknown): boolean {
    return isRecord(value)
        && isStringOrNull(value.title) && isStringOrNull(value.description) && isStringOrNull(value.price)
        && Array.isArray(value.images) && value.images.every(isAttachment)
        && isStringOrNull(value.selectedImageId);
}

function isProductSelection(value: unknown): value is NonNullable<CreativeBrief['product']> {
    if (!isRecord(value) || !hasString(value, 'id') || !hasString(value, 'name')) return false;
    if (value.kind === 'product-url') {
        if (!hasString(value, 'url')) return false;
        // A malformed imported payload is dropped (link-only), not fatal: the
        // marker is parsed from persisted user messages on every render.
        if (value.imported !== undefined && !isImportedProductData(value.imported)) delete value.imported;
        return true;
    }
    return value.kind === 'product-image' && isAttachment(value.attachment);
}

function isVoiceSelection(value: unknown): value is NonNullable<CreativeBrief['voice']> {
    return isRecord(value) && value.kind === 'voice' && hasString(value, 'id') && hasString(value, 'name')
        && hasString(value, 'language') && hasString(value, 'languageLabel')
        && (value.tagline === undefined || typeof value.tagline === 'string');
}

export function parseCreativeBriefDraft(serialized: string | null): CreativeBrief {
    if (!serialized) return createEmptyCreativeBrief();
    try {
        const value: unknown = JSON.parse(serialized);
        if (!isRecord(value)) return createEmptyCreativeBrief();
        const brief = createEmptyCreativeBrief();
        if (isTemplateSelection(value.template)) brief.template = value.template;
        if (isAvatarSelection(value.avatar)) brief.avatar = value.avatar;
        if (isProductSelection(value.product)) brief.product = value.product;
        if (isVoiceSelection(value.voice)) brief.voice = value.voice;
        return brief;
    } catch {
        return createEmptyCreativeBrief();
    }
}

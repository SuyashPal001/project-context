import { describe, expect, it } from 'vitest';
import {
    buildCreativeBriefMessage,
    countCreativeBriefAttachments,
    creativeBriefAttachmentIds,
    creativeMessageDisplayText,
    mergeCreativeBriefAttachments,
    parseCreativeBriefDraft,
    parseCreativeBriefPresentation,
} from './creativeBrief';
import {
    createEmptyCreativeBrief,
    updateCreativeBrief,
    type CreativeBrief,
} from './creativeBriefModel';

const avatarAttachment = { fileId: 'avatar-file', name: 'arjun.jpg', type: 'image/jpeg', size: 120 };
const productAttachment = { fileId: 'product-file', name: 'serum.png', type: 'image/png', size: 240 };

function completeBrief(): CreativeBrief {
    return {
        template: { kind: 'template', id: 'demo', title: 'Product Demo', category: 'Demonstration', image: '/creative/templates/product-demo.png' },
        avatar: { kind: 'avatar', id: 'arjun', name: 'Arjun', role: 'Tech presenter', tone: 'Clear', attachment: avatarAttachment },
        product: { kind: 'product-image', id: 'product-file', name: 'serum.png', attachment: productAttachment },
        voice: { kind: 'voice', id: 'nandi-id', name: 'Nandi', tagline: 'Poised narrator', language: 'hi', languageLabel: 'Hindi' },
    };
}

describe('creative brief', () => {
    it('keeps one selection per field and replaces only that field', () => {
        const first = updateCreativeBrief(createEmptyCreativeBrief(), { kind: 'template', id: 'one', title: 'One', category: 'Demo', image: '/creative/templates/one.png' });
        const withAvatar = updateCreativeBrief(first, { kind: 'avatar', id: 'arjun', name: 'Arjun', role: 'Host', tone: 'Clear', attachment: avatarAttachment });
        const replaced = updateCreativeBrief(withAvatar, { kind: 'template', id: 'two', title: 'Two', category: 'UGC', image: '/creative/templates/two.png' });
        expect(replaced.template?.id).toBe('two');
        expect(replaced.avatar?.id).toBe('arjun');
    });

    it('builds a deterministic request with real provider identifiers', () => {
        const message = buildCreativeBriefMessage('Make a 20-second Instagram ad.', completeBrief());
        expect(message).toContain('User direction:\nMake a 20-second Instagram ad.');
        expect(message).toContain('- Template: Product Demo (Demonstration)');
        expect(message).toContain('- Avatar: Arjun · Tech presenter · Clear');
        expect(message).toContain('- Product: serum.png');
        expect(message).toContain('Voice ID: nandi-id');
        expect(message).toContain('Narration language: Hindi (hi)');
        expect(message).toContain('Do not invent product claims');
    });

    it('builds a request from any subset of creative selections', () => {
        const brief = updateCreativeBrief(createEmptyCreativeBrief(), {
            kind: 'voice', id: 'lauren-id', name: 'Lauren', language: 'en', languageLabel: 'English',
        });
        const message = buildCreativeBriefMessage('', brief);

        expect(message).toContain('- Voice: Lauren');
        expect(message).not.toContain('- Template:');
        expect(message).not.toContain('- Avatar:');
        expect(message).not.toContain('- Product:');
    });

    it('round-trips durable transcript presentation without exposing the agent brief', () => {
        const brief = completeBrief();
        const message = buildCreativeBriefMessage('Make it upbeat → then close with “Shop now”.', brief);
        const presentation = parseCreativeBriefPresentation(message);

        expect(presentation).toEqual({ direction: 'Make it upbeat → then close with “Shop now”.', brief });
        expect(creativeMessageDisplayText(message)).toBe('Make it upbeat → then close with “Shop now”.');
        expect(creativeBriefAttachmentIds(brief)).toEqual(new Set(['avatar-file', 'product-file']));
    });

    it('does not interpret malformed transcript metadata', () => {
        const malformed = 'Creative brief:\n<!-- olmo-creative-brief:v1:%ZZ -->';
        expect(parseCreativeBriefPresentation(malformed)).toBeNull();
        expect(creativeMessageDisplayText(malformed)).toBe(malformed);
    });

    it('rejects untrusted image paths from persisted and transcript data', () => {
        const brief = completeBrief();
        const unsafeBrief = { ...brief, template: { ...brief.template!, image: 'https://untrusted.example/image.jpg' } };
        expect(parseCreativeBriefDraft(JSON.stringify(unsafeBrief)).template).toBeNull();

        const unsafeMessage = buildCreativeBriefMessage('Create it.', unsafeBrief);
        const presentation = parseCreativeBriefPresentation(unsafeMessage);
        expect(presentation?.brief.template).toBeNull();
        expect(presentation?.brief.avatar?.name).toBe('Arjun');
    });

    it('deduplicates existing and brief attachments by fileId', () => {
        const attachments = mergeCreativeBriefAttachments([avatarAttachment], completeBrief());
        expect(attachments).toEqual([avatarAttachment, productAttachment]);
    });

    it('counts a pending recording alongside deduplicated creative attachments', () => {
        expect(countCreativeBriefAttachments([avatarAttachment], completeBrief(), true)).toBe(3);
    });

    it('still parses a historical message annotation that carries the old prompt field', () => {
        // Simulates a chat message persisted before this change shipped — its
        // JSON still has `prompt` on the template selection. isTemplateSelection
        // must accept this without requiring `prompt`, or every past templated
        // message stops rendering the moment this ships.
        const legacyBrief = {
            template: { kind: 'template', id: 'demo', title: 'Product Demo', category: 'Demonstration', prompt: 'Show it.', image: '/creative/templates/product-demo.png' },
            avatar: null, product: null, voice: null,
        };
        const encoded = encodeURIComponent(JSON.stringify({ direction: 'Make an ad', brief: legacyBrief })).replaceAll('-', '%2D');
        const content = `some direction text\n\n<!-- olmo-creative-brief:v1:${encoded} -->`;

        const parsed = parseCreativeBriefPresentation(content);

        expect(parsed).not.toBeNull();
        expect(parsed!.brief.template).toEqual(
            expect.objectContaining({ id: 'demo', title: 'Product Demo', category: 'Demonstration' }),
        );
    });

    it('restores valid drafts and discards malformed persisted values', () => {
        const brief = completeBrief();
        expect(parseCreativeBriefDraft(JSON.stringify(brief))).toEqual(brief);
        expect(parseCreativeBriefDraft('{bad json')).toEqual(createEmptyCreativeBrief());
        expect(parseCreativeBriefDraft(JSON.stringify({ ...brief, avatar: { kind: 'avatar' } })).avatar).toBeNull();
    });
});

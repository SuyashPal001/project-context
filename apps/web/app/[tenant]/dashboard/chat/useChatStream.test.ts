import { describe, it, expect } from 'vitest';
import { mapStreamAttachments } from './useChatStream';

describe('mapStreamAttachments', () => {
    it('carries generation through when the orchestrator includes it', () => {
        // Regression: a prior fix (b43e03d9) dropped `generation` from this
        // exact map, so a just-generated image's credit pill never appeared
        // even in the same turn — only caught by a whole-branch review, not
        // any per-task test. This is the test that closes that gap.
        const [result] = mapStreamAttachments([
            { fileId: 'f1', name: 'x.png', type: 'image/png', size: 100, generation: { creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview' } },
        ]);

        expect(result.generation).toEqual({ creditsUsedMicro: '50000', model: 'gemini-3-pro-image-preview' });
    });

    it('omits generation for a plain user-uploaded attachment', () => {
        const [result] = mapStreamAttachments([
            { fileId: 'f2', name: 'doc.pdf', type: 'application/pdf', size: 200 },
        ]);

        expect(result.generation).toBeUndefined();
    });

    it('synthesizes a local UI id and preserves the rest of the fields', () => {
        const [result] = mapStreamAttachments([
            { fileId: 'f3', name: 'clip.mp4', type: 'video/mp4', size: 300 },
        ]);

        expect(result.id).toEqual(expect.any(String));
        expect(result.id.length).toBeGreaterThan(0);
        expect(result.fileId).toBe('f3');
        expect(result.name).toBe('clip.mp4');
        expect(result.type).toBe('video/mp4');
        expect(result.size).toBe(300);
    });

    it('maps each attachment independently, in order', () => {
        const results = mapStreamAttachments([
            { fileId: 'a', name: 'a.png', type: 'image/png' },
            { fileId: 'b', name: 'b.png', type: 'image/png', generation: { creditsUsedMicro: '1', model: 'm' } },
        ]);

        expect(results).toHaveLength(2);
        expect(results[0].fileId).toBe('a');
        expect(results[0].generation).toBeUndefined();
        expect(results[1].fileId).toBe('b');
        expect(results[1].generation).toEqual({ creditsUsedMicro: '1', model: 'm' });
    });

    it('returns an empty array for an empty input', () => {
        expect(mapStreamAttachments([])).toEqual([]);
    });
});

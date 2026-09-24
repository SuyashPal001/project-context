/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { mediaGenFailureReason } from './ToolCallCard';

describe('mediaGenFailureReason for batch tools', () => {
    it('reports no failure when at least one item produced a file', () => {
        expect(mediaGenFailureReason('generate_videos', {
            results: [{ index: 0, fileId: 'f' }, { index: 1, refused: true }],
        })).toBeNull();
    });

    it('reports a failure when no item produced a file', () => {
        expect(mediaGenFailureReason('generate_videos', { results: [{ index: 0, refused: true }] })).toBe('Video generation failed');
    });

    it('reports Out of credits when every item in the batch is insufficientCredits', () => {
        expect(mediaGenFailureReason('generate_images', { results: [{ index: 0, insufficientCredits: true }] })).toBe('Out of credits');
        expect(mediaGenFailureReason('generate_images', {
            results: [{ index: 0, insufficientCredits: true }, { index: 1, insufficientCredits: true }],
        })).toBe('Out of credits');
    });

    it('falls back to the generic failure when only some items are insufficientCredits', () => {
        expect(mediaGenFailureReason('generate_images', {
            results: [{ index: 0, insufficientCredits: true }, { index: 1, refused: true }],
        })).toBe('Image generation failed');
    });

    it('still handles a single-item result', () => {
        expect(mediaGenFailureReason('generate_video', { fileId: 'f' })).toBeNull();
        expect(mediaGenFailureReason('generate_video', { refused: true })).toBe('Video generation failed');
    });
});

describe('mediaGenFailureReason — thrown tool', () => {
  it('reads { failed: true } as a failure, not success', () => {
    expect(mediaGenFailureReason('generate_image', { failed: true })).toBe('Image generation failed')
    expect(mediaGenFailureReason('generate_video', { failed: true })).toBe('Video generation failed')
  })
})

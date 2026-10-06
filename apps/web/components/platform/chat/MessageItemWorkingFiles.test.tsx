/** @vitest-environment jsdom */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageItem } from './MessageItem';
import type { Message } from './types';
import { typeBadge } from '@/components/platform/canvas/assetTypeStyles';

vi.stubGlobal('ResizeObserver', class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
afterEach(() => cleanup());

const att = (n: number, name: string, type: string, working = false) => ({ id: `a${n}`, fileId: `f${n}`, name, type, size: 1, ...(working ? { working: true } : {}) });

describe('a finished ad shows its result, not its working files', () => {
    it('folds the working files behind one row that opens on tap', () => {
        const message: Message = {
            id: 'm1', conversationId: 'c1', role: 'assistant', content: 'Your ad is ready.', createdAt: '2026-10-06T10:00:00.000Z',
            attachments: [
                att(1, 'Generated Narration.wav', 'audio/wav', true),
                att(2, 'Beat with Audio.mp4', 'video/mp4', true),
                att(3, 'Captioned Video.mp4', 'video/mp4', true),
                att(4, 'Final Video.mp4', 'video/mp4'),
            ],
        };
        render(<MessageItem message={message} freshUrls={{}} creatingPlanId={null} planErrors={{}} onCreateInSystem={vi.fn()} />);
        expect(screen.getByText('Final Video.mp4')).toBeTruthy();
        expect(screen.queryByLabelText('Beat with Audio.mp4')).toBeNull();
        fireEvent.click(screen.getByText('3 working files'));
        expect(screen.getByLabelText('Beat with Audio.mp4')).toBeTruthy();
    });
});

describe('typeBadge', () => {
    it('shows the real audio and video format', () => {
        expect(typeBadge('audio', 'Generated Narration.wav')).toBe('WAV');
        expect(typeBadge('audio', 'Upbeat bed.mp3')).toBe('MP3');
        expect(typeBadge('video', 'Final Video.mov')).toBe('MOV');
        expect(typeBadge('image', 'still.png')).toBe('IMG');
        expect(typeBadge('audio')).toBe('MP3');
    });
});

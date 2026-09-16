/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageItem } from './MessageItem';
import { buildCreativeBriefMessage } from './creative-library/creativeBrief';
import type { CreativeBrief } from './creative-library/creativeBriefModel';
import type { Message } from './types';

vi.mock('./GeneratedAssetCard', () => ({
    GeneratedAssetCard: () => <div data-testid="large-asset-card" />,
}));

vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
});

describe('MessageItem creative brief presentation', () => {
    it('shows the user direction and previewable read-only pills instead of the internal brief', async () => {
        const brief: CreativeBrief = {
            template: { kind: 'template', id: 'demo', title: 'Product Demo', category: 'Demonstration', image: '/creative/templates/product-demo.png' },
            avatar: { kind: 'avatar', id: 'mira', name: 'Mira', role: 'Creator', tone: 'Casual', image: '/creative/avatars/everyday-creator.jpg', attachment: { fileId: 'avatar-file', name: 'mira.jpg', type: 'image/jpeg', size: 100 } },
            product: null,
            voice: { kind: 'voice', id: 'lauren', name: 'Lauren', language: 'en', languageLabel: 'English' },
        };
        const message: Message = {
            id: 'message-1',
            conversationId: 'conversation-1',
            role: 'user',
            content: buildCreativeBriefMessage('Create a short launch video.', brief),
            createdAt: '2026-09-15T10:00:00.000Z',
            attachments: [{ id: 'attachment-1', fileId: 'avatar-file', name: 'mira.jpg', type: 'image/jpeg', size: 100 }],
        };

        render(<MessageItem
            message={message}
            freshUrls={{}}
            creatingPlanId={null}
            planErrors={{}}
            onCreateInSystem={vi.fn()}
        />);

        expect(screen.getByText('Create a short launch video.')).toBeTruthy();
        expect(screen.queryByText('Creative brief:')).toBeNull();
        expect(screen.getByLabelText('Template Product Demo')).toBeTruthy();
        expect(screen.getByLabelText('Avatar Mira')).toBeTruthy();
        expect(screen.getByLabelText('Voice Lauren · English')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Remove template' })).toBeNull();
        expect(screen.queryByTestId('large-asset-card')).toBeNull();

        fireEvent.focus(screen.getByLabelText('Template Product Demo'));
        await waitFor(() => expect(screen.getAllByText('Demonstration').length).toBeGreaterThan(0));
    });
});

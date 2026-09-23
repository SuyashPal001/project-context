/** @vitest-environment jsdom */
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageThread } from './MessageThread';
import { api } from '@/lib/api';
import type { Message } from './types';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/app/[tenant]/tenant-provider', () => ({ useTenant: () => ({ tenantId: 'tenant-1', userId: 'user-1' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useParams: () => ({ tenant: 'acme' }) }));
// Each of these renders a distinguishable marker so the test can assert the
// surrounding tree mounted without needing that child's own real behavior —
// this test is only about the presign-fallback logic in the reload-refresh
// effect, not about these components' own rendering.
vi.mock('./AgentOrb', () => ({ AgentOrb: () => <div data-testid="agent-orb" /> }));
vi.mock('./ThinkingIndicator', () => ({ ThinkingIndicator: () => <div data-testid="thinking-indicator" /> }));
vi.mock('./MessageItem', () => ({
    MessageItem: (props: Record<string, unknown>) => <div data-testid="message-item">{JSON.stringify(props)}</div>,
    messageHasDisplayedContent: () => true,
}));
vi.mock('./ClarificationCard', () => ({ ClarificationCard: () => <div data-testid="clarification-card" /> }));
vi.mock('./UploadRequestCard', () => ({ UploadRequestCard: () => <div data-testid="upload-request-card" /> }));
vi.mock('@/components/platform/credits/ApproveCost', () => ({ ApproveCost: () => <div data-testid="approve-cost" /> }));

beforeEach(() => {
    vi.clearAllMocks();
    // jsdom doesn't implement scrollTo — the mount-time anchor-scroll effect
    // calls it unconditionally, which throws before the refresh effect this
    // test cares about ever runs.
    Element.prototype.scrollTo = vi.fn();
});

const baseMessage: Message = {
    id: 'msg-1',
    conversationId: 'conversation-1',
    role: 'user',
    content: 'here is an image',
    createdAt: new Date().toISOString(),
    attachments: [
        {
            id: 'att-1',
            fileId: '8b6e9254-cc47-492c-bdc7-557ac6302e01',
            name: 'avatar.jpg',
            type: 'image/jpeg',
            // No previewUrl — forces the reload-time refresh path to fetch a
            // fresh presigned URL for this attachment on mount.
        },
    ],
};

describe('MessageThread attachment URL refresh', () => {
    it('falls back to the creative-library-assets route for a fileId the tenant lookup 404s on', async () => {
        vi.mocked(api.get).mockImplementation(async (path: string) => {
            if (path.includes('/files/')) {
                const err = new Error('Not Found') as Error & { status?: number };
                err.status = 404;
                throw err;
            }
            if (path.includes('/creative-library-assets/')) {
                return { presignedUrl: 'https://library.example/avatar.jpg' };
            }
            throw new Error(`unexpected path ${path}`);
        });

        render(<MessageThread messages={[baseMessage]} />);

        await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/creative-library-assets/')));
    });
});

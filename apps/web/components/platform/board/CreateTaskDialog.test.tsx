/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render as rtlRender, screen, cleanup, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { CreateTaskDialog } from './CreateTaskDialog';

// Radix's DropdownMenu relies on pointer-capture and scrollIntoView APIs
// jsdom doesn't implement — without these, opening/selecting from the
// assignee menu throws instead of rendering the popover content.
beforeAll(() => {
    if (!Element.prototype.hasPointerCapture) {
        Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = () => {};
    }
});

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('@/lib/api', () => {
    class FakeApiError extends Error {
        status: number;
        data: unknown;
        constructor(status: number, data: unknown) {
            super(`API Error: ${status}`);
            this.status = status;
            this.data = data;
        }
    }
    return {
        api: {
            get: (...args: unknown[]) => apiGetMock(...args),
            post: (...args: unknown[]) => apiPostMock(...args),
        },
        ApiError: FakeApiError,
    };
});

vi.mock('@/app/[tenant]/tenant-provider', () => ({
    useTenant: () => ({ tenantSlug: 'acme' }),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
    cleanup();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
});

function render(ui: ReactElement): RenderResult {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function mockAgentsAndMembers() {
    apiGetMock.mockImplementation((path: string) => {
        if (path === '/api/v1/agents') {
            return Promise.resolve({ data: [{ id: 'agent-1', name: 'Doc Bot', status: 'active' }] });
        }
        if (path === '/api/v1/members') {
            return Promise.resolve({ members: [] });
        }
        if (path.startsWith('/api/v1/credits/estimate')) {
            return Promise.resolve({
                costMicro: '2000000',
                balanceMicro: '10000000',
                sufficient: true,
                rateId: 'rate-1',
                rateVersion: 1,
                unlimited: false,
            });
        }
        throw new Error(`Unexpected GET ${path}`);
    });
}

async function fillTitleAndAssignAgent(user: ReturnType<typeof userEvent.setup>) {
    const titleInput = screen.getByPlaceholderText('Task title');
    await user.type(titleInput, 'Ship the thing');

    await user.click(screen.getByText('No Assignee'));
    await user.click(await screen.findByText('Doc Bot'));
}

describe('CreateTaskDialog — credit gate on agent-assigned tasks', () => {
    it('shows the estimate-and-approve control instead of Create Task once an agent is assigned and submitted', async () => {
        mockAgentsAndMembers();
        const user = userEvent.setup();
        render(<CreateTaskDialog open onOpenChange={vi.fn()} />);

        await fillTitleAndAssignAgent(user);
        await user.click(screen.getByRole('button', { name: 'Create Task' }));

        await screen.findByTestId('approve-cost');
        expect(screen.queryByRole('button', { name: 'Create Task' })).toBeNull();
    });

    it('posts /api/v1/tasks with an idempotencyKey once Approve is clicked', async () => {
        mockAgentsAndMembers();
        apiPostMock.mockResolvedValue({ data: { id: 'task-1' } });
        const user = userEvent.setup();
        render(<CreateTaskDialog open onOpenChange={vi.fn()} />);

        await fillTitleAndAssignAgent(user);
        await user.click(screen.getByRole('button', { name: 'Create Task' }));
        await screen.findByTestId('approve-cost');

        await user.click(screen.getByRole('button', { name: 'Approve' }));

        await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
        const [path, payload] = apiPostMock.mock.calls[0];
        expect(path).toBe('/api/v1/tasks');
        expect(typeof (payload as Record<string, unknown>).idempotencyKey).toBe('string');
        expect((payload as Record<string, unknown>).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
        expect((payload as Record<string, unknown>).agentId).toBe('agent-1');
    });

    it('shows the out-of-credits state (not a generic toast) when the submit comes back 402', async () => {
        mockAgentsAndMembers();
        const { ApiError } = await import('@/lib/api');
        apiPostMock.mockRejectedValue(new ApiError(402, { error: 'Insufficient credits', code: 'INSUFFICIENT_CREDITS' }));
        const { toast } = await import('sonner');
        const user = userEvent.setup();
        render(<CreateTaskDialog open onOpenChange={vi.fn()} />);

        await fillTitleAndAssignAgent(user);
        await user.click(screen.getByRole('button', { name: 'Create Task' }));
        await screen.findByTestId('approve-cost');

        await user.click(screen.getByRole('button', { name: 'Approve' }));

        await waitFor(() => {
            const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
            expect(approveBtn.disabled).toBe(true);
        });
        expect(screen.getByRole('link', { name: /add more/i })).not.toBeNull();
        // The 402 is a specific, distinct signal — not routed through the
        // generic error toast used for every other task-creation failure.
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('does not gate a task with no agent assignee — submits directly with no idempotencyKey', async () => {
        mockAgentsAndMembers();
        apiPostMock.mockResolvedValue({ data: { id: 'task-2' } });
        const user = userEvent.setup();
        render(<CreateTaskDialog open onOpenChange={vi.fn()} />);

        await user.type(screen.getByPlaceholderText('Task title'), 'Plain task');
        await user.click(screen.getByRole('button', { name: 'Create Task' }));

        await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('approve-cost')).toBeNull();
        const [, payload] = apiPostMock.mock.calls[0];
        expect((payload as Record<string, unknown>).idempotencyKey).toBeUndefined();
    });
});

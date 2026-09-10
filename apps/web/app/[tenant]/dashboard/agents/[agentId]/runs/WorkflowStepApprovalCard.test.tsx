/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { WorkflowStepApprovalCard } from './WorkflowStepApprovalCard';

// Mirrors PlanApprovalSurface.test.tsx / PlanReviewPhase.test.tsx's convention:
// mock @/lib/api entirely, keep the mock fn reference at module scope, wrap
// the component under test in a bare QueryClientProvider, and assert on the
// mock's call args plus DOM state.
const apiPutMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@/lib/api', () => ({
    api: { put: (...args: unknown[]) => apiPutMock(...args) },
}));

vi.mock('sonner', () => ({
    toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

afterEach(() => {
    cleanup();
    apiPutMock.mockReset();
    toastErrorMock.mockReset();
});

function render(ui: ReactElement): RenderResult & { client: QueryClient } {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const result = rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
    return { ...result, client };
}

const pendingApproval = {
    stepId: 's1',
    title: 'Send an email',
    toolName: 'gmail_send_message',
    reason: 'requires_approval',
};

describe('WorkflowStepApprovalCard', () => {
    it('renders the step title and the friendly tool-name badge', () => {
        render(<WorkflowStepApprovalCard runId="run-1" pendingApproval={pendingApproval} />);

        expect(screen.getByText('Send an email')).toBeTruthy();
        expect(screen.getByText('Send Email (Gmail)')).toBeTruthy();
    });

    it('falls back to the raw tool name when it has no friendly label', () => {
        render(
            <WorkflowStepApprovalCard
                runId="run-1"
                pendingApproval={{ ...pendingApproval, toolName: 'some_unlabeled_tool' }}
            />,
        );

        expect(screen.getByText('some_unlabeled_tool')).toBeTruthy();
    });

    it('calls api.put with the approve route and {approved: true} on Approve, then invalidates agent-runs', async () => {
        apiPutMock.mockResolvedValueOnce(undefined);
        const { client } = render(<WorkflowStepApprovalCard runId="run-1" pendingApproval={pendingApproval} />);
        const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

        expect(apiPutMock).toHaveBeenCalledWith('/api/v1/agent-runs/run-1/approve', { approved: true });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agent-runs'] });
    });

    it('calls api.put with {approved: false} on Decline, then invalidates agent-runs', async () => {
        apiPutMock.mockResolvedValueOnce(undefined);
        const { client } = render(<WorkflowStepApprovalCard runId="run-1" pendingApproval={pendingApproval} />);
        const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

        await userEvent.click(screen.getByRole('button', { name: 'Decline' }));

        expect(apiPutMock).toHaveBeenCalledWith('/api/v1/agent-runs/run-1/approve', { approved: false });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agent-runs'] });
    });

    it('shows a toast error and does not invalidate when api.put rejects', async () => {
        apiPutMock.mockRejectedValueOnce(new Error('network error'));
        const { client } = render(<WorkflowStepApprovalCard runId="run-1" pendingApproval={pendingApproval} />);
        const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

        expect(toastErrorMock).toHaveBeenCalledWith('Could not approve this step. Please try again.');
        expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('disables both buttons while the approve request is in flight', async () => {
        let resolvePut!: () => void;
        apiPutMock.mockReturnValueOnce(new Promise<void>(resolve => { resolvePut = resolve; }));
        render(<WorkflowStepApprovalCard runId="run-1" pendingApproval={pendingApproval} />);

        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        const declineBtn = screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement;

        await userEvent.click(approveBtn);

        expect(approveBtn.disabled).toBe(true);
        expect(declineBtn.disabled).toBe(true);

        resolvePut();
        await screen.findByRole('button', { name: 'Approve' });
        expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
    });
});

/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PlanReviewPhase } from './PlanReviewPhase';
import type { Task, Step } from '@/types/task';

const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
    api: { get: (...args: unknown[]) => apiGetMock(...args) },
}));

vi.mock('@/app/[tenant]/tenant-provider', () => ({
    useTenant: () => ({ tenantSlug: 'acme' }),
}));

afterEach(() => {
    cleanup();
    apiGetMock.mockReset();
});

function render(ui: ReactElement): RenderResult {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        agentId: 'agent-1',
        assigneeId: null,
        status: 'awaiting_approval',
        priority: 'medium',
        title: 'Ship the thing',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        upvotes: 0,
        downvotes: 0,
        links: [],
        attachmentFileIds: [],
        ...overrides,
    };
}

function makeSteps(n: number): Step[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `step-${i}`,
        stepNumber: i + 1,
        title: `Step ${i + 1}`,
        status: 'pending' as const,
    }));
}

function mockAgentAndEstimate(sufficient = true) {
    apiGetMock.mockImplementation((path: string) => {
        if (path === '/api/v1/agents/agent-1') {
            return Promise.resolve({ llmProvider: { model: 'gemini-2.5-flash' } });
        }
        if (path.startsWith('/api/v1/credits/estimate')) {
            return Promise.resolve({
                costMicro: '4000000',
                balanceMicro: sufficient ? '10000000' : '0',
                sufficient,
                rateId: 'r1',
                rateVersion: 1,
                unlimited: false,
            });
        }
        throw new Error(`unexpected GET ${path}`);
    });
}

describe('PlanReviewPhase — credit gate on the real execution trigger', () => {
    it('does not render a bare "Approve Plan" button — approving now goes through the cost gate', async () => {
        mockAgentAndEstimate();
        render(
            <PlanReviewPhase
                task={makeTask()}
                steps={makeSteps(3)}
                onApprovePlan={vi.fn()}
                onRejectPlan={vi.fn()}
            />,
        );

        await screen.findByTestId('approve-cost');
        expect(screen.queryByText('Approve Plan')).toBeNull();
    });

    it('passes the plan\'s step count to the cost estimate (matching estimateTaskMicro(steps.length, model))', async () => {
        mockAgentAndEstimate();
        render(
            <PlanReviewPhase
                task={makeTask()}
                steps={makeSteps(3)}
                onApprovePlan={vi.fn()}
                onRejectPlan={vi.fn()}
            />,
        );

        await screen.findByTestId('approve-cost');
        const estimateCall = apiGetMock.mock.calls.find(([p]) => (p as string).startsWith('/api/v1/credits/estimate'));
        const query = new URLSearchParams((estimateCall![0] as string).split('?')[1]);
        // 3 steps * {input: 4000, output: 1000} per step
        expect(query.get('inputTokens')).toBe('12000');
        expect(query.get('outputTokens')).toBe('3000');
    });

    it('calls onApprovePlan when Approve is clicked and the estimate is sufficient', async () => {
        mockAgentAndEstimate(true);
        const onApprovePlan = vi.fn();
        render(
            <PlanReviewPhase
                task={makeTask()}
                steps={makeSteps(1)}
                onApprovePlan={onApprovePlan}
                onRejectPlan={vi.fn()}
            />,
        );

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
        expect(onApprovePlan).toHaveBeenCalledTimes(1);
    });

    it('disables Approve when the estimate says insufficient — no way to click through a broke balance', async () => {
        mockAgentAndEstimate(false);
        render(
            <PlanReviewPhase
                task={makeTask()}
                steps={makeSteps(1)}
                onApprovePlan={vi.fn()}
                onRejectPlan={vi.fn()}
            />,
        );

        await screen.findByTestId('approve-cost');
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(true);
    });

    it('still supports "Request Changes" independently of the cost gate', async () => {
        mockAgentAndEstimate();
        const onRejectPlan = vi.fn().mockResolvedValue(undefined);
        render(
            <PlanReviewPhase
                task={makeTask()}
                steps={makeSteps(1)}
                onApprovePlan={vi.fn()}
                onRejectPlan={onRejectPlan}
            />,
        );

        await userEvent.click(screen.getByRole('button', { name: /Request Changes/i }));
        await userEvent.click(screen.getByRole('button', { name: /Send Feedback/i }));
        expect(onRejectPlan).toHaveBeenCalledTimes(1);
    });

    it('renders nothing for the review/approve card once the task has moved past awaiting_approval', () => {
        render(
            <PlanReviewPhase
                task={makeTask({ status: 'ready' })}
                steps={makeSteps(1)}
                onApprovePlan={vi.fn()}
                onRejectPlan={vi.fn()}
            />,
        );
        expect(screen.queryByTestId('approve-cost')).toBeNull();
        expect(apiGetMock).not.toHaveBeenCalled();
    });
});

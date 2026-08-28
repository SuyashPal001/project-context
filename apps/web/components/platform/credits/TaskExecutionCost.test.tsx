/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { TaskExecutionCost } from './TaskExecutionCost';

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

async function expectEnabledApprove() {
    const approveBtn = (await screen.findByRole('button', { name: 'Approve' })) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(false);
    return approveBtn;
}

describe('TaskExecutionCost', () => {
    it('fetches the agent detail, then estimates llm_tokens at the agent\'s real llmProvider.model — not agents.model', async () => {
        apiGetMock.mockImplementation((path: string) => {
            if (path === '/api/v1/agents/agent-1') {
                return Promise.resolve({ llmProvider: { model: 'gemini-2.5-pro' } });
            }
            if (path.startsWith('/api/v1/credits/estimate')) {
                return Promise.resolve({
                    costMicro: '3000000', balanceMicro: '10000000', sufficient: true,
                    rateId: 'r1', rateVersion: 1, unlimited: false,
                });
            }
            throw new Error(`unexpected GET ${path}`);
        });

        render(<TaskExecutionCost agentId="agent-1" stepCount={2} onApprove={vi.fn()} />);

        await screen.findByTestId('approve-cost');

        const estimateCall = apiGetMock.mock.calls.find(([p]) => (p as string).startsWith('/api/v1/credits/estimate'));
        expect(estimateCall).toBeDefined();
        const query = new URLSearchParams((estimateCall![0] as string).split('?')[1]);
        expect(query.get('resourceType')).toBe('llm_tokens');
        expect(query.get('subject')).toBe('gemini-2.5-pro');
        // 2 steps * AVERAGE_STEP_TOKENS {input: 4000, output: 1000} = 8000 / 2000
        expect(query.get('inputTokens')).toBe('8000');
        expect(query.get('outputTokens')).toBe('2000');
    });

    it('falls back to the ollama subject for an ollama/* model, same as the orchestrator', async () => {
        apiGetMock.mockImplementation((path: string) => {
            if (path === '/api/v1/agents/agent-1') {
                return Promise.resolve({ llmProvider: { model: 'ollama/llama3' } });
            }
            return Promise.resolve({
                costMicro: '0', balanceMicro: '10000000', sufficient: true,
                rateId: 'r1', rateVersion: 1, unlimited: false,
            });
        });

        render(<TaskExecutionCost agentId="agent-1" stepCount={1} onApprove={vi.fn()} />);
        await screen.findByTestId('approve-cost');

        const estimateCall = apiGetMock.mock.calls.find(([p]) => (p as string).startsWith('/api/v1/credits/estimate'));
        const query = new URLSearchParams((estimateCall![0] as string).split('?')[1]);
        expect(query.get('subject')).toBe('ollama');
    });

    it('falls back to DEFAULT_TASK_MODEL when the agent has no llmProvider', async () => {
        apiGetMock.mockImplementation((path: string) => {
            if (path === '/api/v1/agents/agent-2') {
                return Promise.resolve({ llmProvider: null });
            }
            return Promise.resolve({
                costMicro: '0', balanceMicro: '10000000', sufficient: true,
                rateId: 'r1', rateVersion: 1, unlimited: false,
            });
        });

        render(<TaskExecutionCost agentId="agent-2" stepCount={1} onApprove={vi.fn()} />);
        await screen.findByTestId('approve-cost');

        const estimateCall = apiGetMock.mock.calls.find(([p]) => (p as string).startsWith('/api/v1/credits/estimate'));
        const query = new URLSearchParams((estimateCall![0] as string).split('?')[1]);
        expect(query.get('subject')).toBe('gemini-2.5-flash');
    });

    it('shows an "unknown cost" state with a working Approve, and never calls /credits/estimate, when agentId is null', async () => {
        const onApprove = vi.fn();
        render(<TaskExecutionCost agentId={null} stepCount={3} onApprove={onApprove} />);
        expect(screen.getByTestId('task-execution-cost-unknown')).not.toBeNull();
        expect(apiGetMock).not.toHaveBeenCalled();

        await userEvent.click(await expectEnabledApprove());
        expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('shows the "unknown cost" state with a working Approve (not a crash, not a dead end) when the agent lookup fails', async () => {
        apiGetMock.mockRejectedValue(new Error('boom'));
        const onApprove = vi.fn();
        render(<TaskExecutionCost agentId="agent-1" stepCount={2} onApprove={onApprove} />);
        await screen.findByTestId('task-execution-cost-unknown');

        await userEvent.click(await expectEnabledApprove());
        expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('still offers a working Approve when the agent resolves but the cost estimate itself fails', async () => {
        apiGetMock.mockImplementation((path: string) => {
            if (path === '/api/v1/agents/agent-1') {
                return Promise.resolve({ llmProvider: { model: 'gemini-2.5-flash' } });
            }
            if (path.startsWith('/api/v1/credits/estimate')) {
                return Promise.reject(new Error('estimate service down'));
            }
            throw new Error(`unexpected GET ${path}`);
        });
        const onApprove = vi.fn();
        render(<TaskExecutionCost agentId="agent-1" stepCount={2} onApprove={onApprove} />);
        await screen.findByTestId('approve-cost-error');

        await userEvent.click(await expectEnabledApprove());
        expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('calls onApprove when the resulting ApproveCost control is approved', async () => {
        apiGetMock.mockImplementation((path: string) => {
            if (path === '/api/v1/agents/agent-1') {
                return Promise.resolve({ llmProvider: { model: 'gemini-2.5-flash' } });
            }
            return Promise.resolve({
                costMicro: '1000000', balanceMicro: '10000000', sufficient: true,
                rateId: 'r1', rateVersion: 1, unlimited: false,
            });
        });
        const onApprove = vi.fn();
        render(<TaskExecutionCost agentId="agent-1" stepCount={1} onApprove={onApprove} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

        expect(onApprove).toHaveBeenCalledTimes(1);
    });
});

/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ApproveCost } from './ApproveCost';

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

describe('ApproveCost', () => {
    it('shows a loading state before the estimate resolves', () => {
        apiGetMock.mockReturnValue(new Promise(() => {})); // never resolves
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} />);
        expect(screen.getByTestId('approve-cost-loading')).not.toBeNull();
    });

    it('divides costMicro by 1,000,000 for display and does not show the balance', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        render(<ApproveCost label="Generate song" resourceType="tool_call" subject="task.create" onApprove={vi.fn()} />);

        const el = await screen.findByTestId('approve-cost');
        expect(el.textContent).toContain('~2 credits');
        expect(el.textContent).not.toContain('Balance');
    });

    it('renders "Unlimited" with no cost figure when the tenant is unlimited, and Approve stays enabled', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: true,
        });
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} />);

        const el = await screen.findByTestId('approve-cost-unlimited');
        expect(el.textContent).toContain('Unlimited plan');
        expect(el.textContent).not.toContain('credits');
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(false);
    });

    it('disables Approve and shows a billing link when sufficient is false', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '500000',
            sufficient: false,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} />);

        await screen.findByTestId('approve-cost');
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(true);
        const link = screen.getByRole('link', { name: /add more/i }) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/acme/dashboard/billing');
    });

    it('calls onApprove when Approve is clicked and the estimate is sufficient', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onApprove = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={onApprove} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

        expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('calls onCancel when Cancel is clicked', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onCancel = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={onCancel} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('still offers an enabled Approve when the estimate call fails — a preview failure must never block approval', async () => {
        apiGetMock.mockRejectedValue(new Error('network error'));
        const onApprove = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={onApprove} />);

        await waitFor(() => expect(screen.getByTestId('approve-cost-error')).not.toBeNull());
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(false);

        await userEvent.click(approveBtn);
        expect(onApprove).toHaveBeenCalledTimes(1);
    });
});

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
        render(<ApproveCost resourceType="tool_call" onApprove={vi.fn()} />);
        expect(screen.getByTestId('approve-cost-loading')).not.toBeNull();
    });

    it('divides costMicro and balanceMicro by 1,000,000 for display', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        render(<ApproveCost resourceType="tool_call" subject="task.create" onApprove={vi.fn()} />);

        const el = await screen.findByTestId('approve-cost');
        expect(el.textContent).toContain('This costs');
        expect(screen.getByText('2')).not.toBeNull(); // cost credits
        expect(screen.getByText('10')).not.toBeNull(); // balance credits
    });

    it('renders "Unlimited" with no cost figure when the tenant is unlimited, and Approve stays enabled', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: true,
        });
        render(<ApproveCost resourceType="tool_call" onApprove={vi.fn()} />);

        await screen.findByTestId('approve-cost-unlimited');
        expect(screen.getByText('Unlimited')).not.toBeNull();
        expect(screen.queryByText('2')).toBeNull();
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
        render(<ApproveCost resourceType="tool_call" onApprove={vi.fn()} />);

        await screen.findByTestId('approve-cost');
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(true);
        const link = screen.getByRole('link', { name: /add more/i }) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/acme/dashboard/billing');
    });

    it('forces the insufficient state via insufficientOverride even when the cached estimate says sufficient', async () => {
        // Models the 402 path: the estimate said sufficient, but the actual
        // spend at submit time came back 402 because balance moved between
        // the estimate call and the submit.
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        render(<ApproveCost resourceType="tool_call" onApprove={vi.fn()} insufficientOverride />);

        await screen.findByTestId('approve-cost');
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(true);
        expect(screen.getByRole('link', { name: /add more/i })).not.toBeNull();
    });

    it('calls onApprove with a freshly generated idempotency key when sufficient', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onApprove = vi.fn();
        render(<ApproveCost resourceType="tool_call" onApprove={onApprove} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

        expect(onApprove).toHaveBeenCalledTimes(1);
        const key = onApprove.mock.calls[0][0];
        expect(typeof key).toBe('string');
        expect(key).toMatch(/^[0-9a-f-]{36}$/i);
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
        render(<ApproveCost resourceType="tool_call" onApprove={vi.fn()} onCancel={onCancel} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('shows an error state and does not crash when the estimate call fails', async () => {
        apiGetMock.mockRejectedValue(new Error('network error'));
        render(<ApproveCost resourceType="tool_call" onApprove={vi.fn()} />);

        await waitFor(() => expect(screen.getByTestId('approve-cost-error')).not.toBeNull());
    });
});

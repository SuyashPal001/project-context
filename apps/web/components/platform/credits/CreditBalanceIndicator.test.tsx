/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { CreditBalanceIndicator } from './CreditBalanceIndicator';

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

function mockEndpoints(balance: unknown, usageByType: unknown) {
    apiGetMock.mockImplementation((url: string) => {
        if (url.includes('/credits/usage-by-type')) return Promise.resolve(usageByType);
        return Promise.resolve(balance);
    });
}

describe('CreditBalanceIndicator', () => {
    it('renders nothing before the balance loads', () => {
        apiGetMock.mockReturnValue(new Promise(() => {}));
        const { container } = render(<CreditBalanceIndicator />);
        expect(container.firstChild).toBeNull();
    });

    it('shows the balance as a clickable trigger', async () => {
        mockEndpoints({ unlimited: false, balanceMicro: '5000000', grants: [] }, {});
        render(<CreditBalanceIndicator />);
        const trigger = await screen.findByTestId('credit-balance');
        expect(trigger.textContent).toContain('5');
        expect(trigger.tagName).toBe('BUTTON');
    });

    it('opens the credits panel with a type breakdown, total, and percent-consumed on click', async () => {
        mockEndpoints(
            { unlimited: false, balanceMicro: '5000000', grants: [] },
            {
                unlimited: false,
                balanceMicro: '5000000',
                byType: { text: '1000000', image: '2000000', video: '1500000', audio: '500000' },
                totalMicro: '5000000',
                lastGrant: { amountMicro: '10000000', spentMicro: '5000000', grantType: 'purchase' },
            },
        );
        render(<CreditBalanceIndicator />);
        const trigger = await screen.findByTestId('credit-balance');
        await userEvent.click(trigger);

        const panel = await screen.findByTestId('credits-panel');
        expect(panel.textContent).toContain('Text credits');
        expect(panel.textContent).toContain('Image credits');
        expect(panel.textContent).toContain('Video credits');
        expect(panel.textContent).toContain('Audio credits');
        expect(panel.textContent).toContain('Total credits');
        expect(screen.getByTestId('credits-panel-percent').textContent).toContain('50%');
    });

    it('omits the percent-consumed figure when the tenant has no grants yet', async () => {
        mockEndpoints(
            { unlimited: false, balanceMicro: '0', grants: [] },
            {
                unlimited: false,
                balanceMicro: '0',
                byType: { text: '0', image: '0', video: '0', audio: '0' },
                totalMicro: '0',
                lastGrant: null,
            },
        );
        render(<CreditBalanceIndicator />);
        await userEvent.click(await screen.findByTestId('credit-balance'));

        await screen.findByTestId('credits-panel');
        expect(screen.queryByTestId('credits-panel-percent')).toBeNull();
    });

    it('links Top-up credits to the billing page', async () => {
        mockEndpoints(
            { unlimited: false, balanceMicro: '5000000', grants: [] },
            {
                unlimited: false,
                balanceMicro: '5000000',
                byType: { text: '1000000', image: '2000000', video: '1500000', audio: '500000' },
                totalMicro: '5000000',
                lastGrant: null,
            },
        );
        render(<CreditBalanceIndicator />);
        await userEvent.click(await screen.findByTestId('credit-balance'));

        const link = await screen.findByTestId('credits-panel-topup');
        expect(link.getAttribute('href')).toBe('/acme/dashboard/billing');
    });

    it('renders the unlimited state with no clickable trigger', async () => {
        mockEndpoints({ unlimited: true }, {});
        render(<CreditBalanceIndicator />);
        expect(await screen.findByTestId('credit-balance-unlimited')).not.toBeNull();
        expect(screen.queryByTestId('credit-balance')).toBeNull();
    });
});

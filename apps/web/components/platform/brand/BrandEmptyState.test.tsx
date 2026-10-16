/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandEmptyState } from './BrandEmptyState';

describe('BrandEmptyState', () => {
    it('shows the three first-run choices', () => {
        render(<BrandEmptyState chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={vi.fn()} busy={false} failed={false} onStartManual={vi.fn()} />);
        expect(screen.getByText('Fill from my website or Instagram')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Set it up with Olmo in chat' })).toBeTruthy();
        expect(screen.getByText('Fill it in myself')).toBeTruthy();
    });

    it('reveals the paste box under "Fill from my website…" and submit still calls onSubmit(value)', () => {
        const onSubmit = vi.fn();
        render(<BrandEmptyState chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={onSubmit} busy={false} failed={false} onStartManual={vi.fn()} />);
        expect(screen.queryByPlaceholderText(/yourbrand\.com/i)).toBeNull();

        fireEvent.click(screen.getByText('Fill from my website or Instagram'));
        fireEvent.change(screen.getByPlaceholderText(/yourbrand\.com/i), { target: { value: '@mamaearth.in' } });
        fireEvent.click(screen.getByRole('button', { name: /fill in/i }));
        expect(onSubmit).toHaveBeenCalledWith('@mamaearth.in');
    });

    it('"Set it up with Olmo" link href is unchanged', () => {
        render(<BrandEmptyState chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={vi.fn()} busy={false} failed={false} onStartManual={vi.fn()} />);
        const link = screen.getByRole('link', { name: 'Set it up with Olmo in chat' }) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/t/dashboard/chat?prefill=Set%20up%20my%20brand');
    });

    it('"Fill it in myself" starts the steps', () => {
        const onStartManual = vi.fn();
        render(<BrandEmptyState chatHref="/t" onSubmit={vi.fn()} busy={false} failed={false} onStartManual={onStartManual} />);
        fireEvent.click(screen.getByText('Fill it in myself'));
        expect(onStartManual).toHaveBeenCalled();
    });

    it('shows the plain failure line after a failed read', () => {
        render(<BrandEmptyState chatHref="/x" onSubmit={vi.fn()} busy={false} failed onStartManual={vi.fn()} />);
        expect(screen.getByText("Couldn't read that. Tell Olmo about your brand instead.")).toBeTruthy();
    });
});

/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandEmptyState } from './BrandEmptyState';

describe('BrandEmptyState', () => {
    it('submits what the user pasted', () => {
        const onSubmit = vi.fn();
        render(<BrandEmptyState chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={onSubmit} busy={false} failed={false} />);
        fireEvent.change(screen.getByPlaceholderText(/yourbrand\.com/i), { target: { value: '@mamaearth.in' } });
        fireEvent.click(screen.getByRole('button', { name: /fill in/i }));
        expect(onSubmit).toHaveBeenCalledWith('@mamaearth.in');
    });

    it('links to chat for brands with no website', () => {
        render(<BrandEmptyState chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={vi.fn()} busy={false} failed={false} />);
        const link = screen.getByRole('link', { name: /tell olmo about your brand/i }) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/t/dashboard/chat?prefill=Set%20up%20my%20brand');
    });

    it('shows the plain failure line after a failed read', () => {
        render(<BrandEmptyState chatHref="/x" onSubmit={vi.fn()} busy={false} failed />);
        expect(screen.getByText("Couldn't read that. Tell Olmo about your brand instead.")).toBeTruthy();
    });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PdfPreview } from './PdfPreview';

// The preview probes the presigned URL before handing it to the iframe. These
// stub that probe: `%PDF` marks a real document, anything else is whatever the
// URL actually served — in practice an S3 error body.
function stubFetch(init: { ok: boolean; status?: number; body?: string }) {
    const body = init.body ?? '';
    return vi.fn().mockResolvedValue({
        ok: init.ok,
        status: init.status ?? (init.ok ? 206 : 403),
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    });
}

describe('PdfPreview', () => {
    beforeEach(() => { vi.stubGlobal('fetch', stubFetch({ ok: true, body: '%PDF-1.7' })); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('renders the viewer once the URL is confirmed to serve a PDF', async () => {
        const { container } = render(<PdfPreview url="https://s3.example/doc.pdf" />);
        await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    });

    // The bug this exists for: the API role lacked s3:GetObject, S3 returned an
    // AccessDenied body, and the iframe rendered that error as though it were
    // the document — white page, black text, no indication anything failed.
    it('shows a themed error instead of iframing an S3 error body', async () => {
        vi.stubGlobal('fetch', stubFetch({
            ok: false,
            status: 403,
            body: '<Error><Code>AccessDenied</Code></Error>',
        }));

        const { container } = render(<PdfPreview url="https://s3.example/doc.pdf" />);

        expect(await screen.findByText(/couldn.t load this pdf/i)).toBeDefined();
        expect(container.querySelector('iframe')).toBeNull();
    });

    it('does not iframe a 200 response that is not actually a PDF', async () => {
        vi.stubGlobal('fetch', stubFetch({ ok: true, status: 200, body: '<html>nope</html>' }));

        const { container } = render(<PdfPreview url="https://s3.example/doc.pdf" />);

        expect(await screen.findByText(/couldn.t load this pdf/i)).toBeDefined();
        expect(container.querySelector('iframe')).toBeNull();
    });

    it('offers a download link when the preview fails', async () => {
        vi.stubGlobal('fetch', stubFetch({ ok: false, body: 'denied' }));

        render(<PdfPreview url="https://s3.example/doc.pdf" />);

        const link = await screen.findByRole('link', { name: /download/i });
        expect(link.getAttribute('href')).toBe('https://s3.example/doc.pdf');
    });
});

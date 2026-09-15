/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCreativeBriefDraft } from './useCreativeBriefDraft';
import { createEmptyCreativeBrief, updateCreativeBrief } from './creativeBriefModel';

function Probe({ storageKey }: { storageKey: string }) {
    const { creativeBrief } = useCreativeBriefDraft(storageKey);
    return <span>{creativeBrief.template?.title ?? 'Empty'}</span>;
}

beforeEach(() => sessionStorage.clear());

describe('useCreativeBriefDraft', () => {
    it('restores without overwriting the saved draft during Strict Mode effect replay', async () => {
        const saved = updateCreativeBrief(createEmptyCreativeBrief(), {
            kind: 'template', id: 'demo', title: 'Product Demo', category: 'Demonstration', prompt: 'Show it.', image: '/creative/templates/product-demo.png',
        });
        sessionStorage.setItem('creative:test', JSON.stringify(saved));

        render(<StrictMode><Probe storageKey="creative:test" /></StrictMode>);

        await screen.findByText('Product Demo');
        await waitFor(() => expect(JSON.parse(sessionStorage.getItem('creative:test') ?? '{}').template?.id).toBe('demo'));
    });
});

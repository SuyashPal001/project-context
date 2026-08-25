/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stagePendingAttachments, consumePendingAttachments } from './pendingAttachments';
import type { Attachment } from '@/types/agent-events';

const KEY = 'pc:pending-attachments';

const file = (fileId: string): Attachment => ({
    fileId,
    name: `${fileId}.pdf`,
    type: 'application/pdf',
    size: 1024,
});

describe('pendingAttachments', () => {
    beforeEach(() => {
        sessionStorage.clear();
        vi.useRealTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('hands staged attachments to the next consumer', () => {
        stagePendingAttachments([file('a'), file('b')]);
        expect(consumePendingAttachments().map(a => a.fileId)).toEqual(['a', 'b']);
    });

    it('clears on consume so the files attach exactly once', () => {
        stagePendingAttachments([file('a')]);
        consumePendingAttachments();
        expect(consumePendingAttachments()).toEqual([]);
        expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('drops a payload older than the handover window', () => {
        vi.useFakeTimers();
        stagePendingAttachments([file('a')]);
        // A navigation the user backed out of must not attach itself to whatever
        // conversation they open later.
        vi.advanceTimersByTime(61_000);
        expect(consumePendingAttachments()).toEqual([]);
    });

    it('keeps a payload consumed within the window', () => {
        vi.useFakeTimers();
        stagePendingAttachments([file('a')]);
        vi.advanceTimersByTime(5_000);
        expect(consumePendingAttachments()).toHaveLength(1);
    });

    it('stages nothing for an empty selection', () => {
        stagePendingAttachments([]);
        expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('returns empty when nothing was staged', () => {
        expect(consumePendingAttachments()).toEqual([]);
    });

    it('survives a corrupted payload', () => {
        sessionStorage.setItem(KEY, '{not json');
        expect(consumePendingAttachments()).toEqual([]);
    });
});

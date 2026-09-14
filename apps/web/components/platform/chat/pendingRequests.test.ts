import { describe, it, expect } from 'vitest';
import { findPendingClarification, findPendingGenerationConfirm, findPendingUpload } from './pendingRequests';
import { normalizeMessages } from './normalizeMessages';
import type { ClarificationRequest, Message, UploadRequest } from './types';

function clarification(id: string, status: ClarificationRequest['status']): ClarificationRequest {
    return { id, status, questions: [{ prompt: 'q?', options: [], allowFreeText: true }] };
}

function upload(id: string, status: UploadRequest['status']): UploadRequest {
    return { id, status, prompt: 'send a file', minFiles: 1, maxFiles: 1 };
}

function message(partial: Partial<Message>): Message {
    return {
        id: partial.id ?? 'm1',
        conversationId: 'c1',
        role: 'assistant',
        content: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...partial,
    };
}

describe('findPendingClarification', () => {
    it('returns nothing when no message carries a clarification', () => {
        expect(findPendingClarification([message({ content: 'hi' })])).toBeUndefined();
    });

    it('finds the pending round buried among resolved rounds on one message', () => {
        // The production bug this file exists for: a single turn asks three
        // times. Rounds 1 and 2 are answered, round 3 is still open.
        const m = message({
            clarificationRequests: [clarification('c-1', 'answered'), clarification('c-2', 'skipped'), clarification('c-3', 'pending')],
        });

        const found = findPendingClarification([m]);

        expect(found?.message.id).toBe('m1');
        expect(found?.request.id).toBe('c-3');
    });

    it('does not block once every round on the newest carrier has resolved', () => {
        const m = message({ clarificationRequests: [clarification('c-1', 'answered'), clarification('c-2', 'answered')] });

        expect(findPendingClarification([m])).toBeUndefined();
    });

    it('stops at the newest carrier rather than surfacing an older stuck round', () => {
        const older = message({ id: 'old', clarificationRequests: [clarification('c-old', 'pending')] });
        const newer = message({ id: 'new', clarificationRequests: [clarification('c-new', 'answered')] });

        expect(findPendingClarification([older, newer])).toBeUndefined();
    });

    it('scans past messages that carry no clarification at all', () => {
        const carrier = message({ id: 'carrier', clarificationRequests: [clarification('c-1', 'pending')] });
        const plain = message({ id: 'plain', content: 'still working' });

        expect(findPendingClarification([carrier, plain])?.request.id).toBe('c-1');
    });

    it('picks the earliest-asked round if several are somehow left pending', () => {
        const m = message({ clarificationRequests: [clarification('c-1', 'pending'), clarification('c-2', 'pending')] });

        expect(findPendingClarification([m])?.request.id).toBe('c-1');
    });
});

describe('findPendingUpload / findPendingGenerationConfirm', () => {
    it('finds a pending upload round among resolved ones', () => {
        const m = message({ uploadRequests: [upload('u-1', 'answered'), upload('u-2', 'pending')] });

        expect(findPendingUpload([m])?.request.id).toBe('u-2');
    });

    it('keeps the single-object generation-confirm shape working', () => {
        const pending = message({ id: 'g', generationConfirmRequest: { id: 'g-1', resourceType: 'image', subject: 's', label: 'l', status: 'pending' } });
        const resolved = message({ id: 'g2', generationConfirmRequest: { id: 'g-2', resourceType: 'image', subject: 's', label: 'l', status: 'approved' } });

        expect(findPendingGenerationConfirm([pending])?.request.id).toBe('g-1');
        expect(findPendingGenerationConfirm([resolved])).toBeUndefined();
    });

    it('sees clarification and upload independently on the same message', () => {
        const m = message({
            clarificationRequests: [clarification('c-1', 'answered')],
            uploadRequests: [upload('u-1', 'pending')],
        });

        expect(findPendingClarification([m])).toBeUndefined();
        expect(findPendingUpload([m])?.request.id).toBe('u-1');
    });
});

describe('normalizeMessages', () => {
    it('lifts the server singular fields into per-round lists', () => {
        const raw = [{ ...message({ id: 'm1' }), clarificationRequest: clarification('c-1', 'answered'), uploadRequest: upload('u-1', 'answered') } as unknown as Message];

        const [normalized] = normalizeMessages(raw);

        expect(normalized.clarificationRequests).toEqual([clarification('c-1', 'answered')]);
        expect(normalized.uploadRequests).toEqual([upload('u-1', 'answered')]);
        expect((normalized as unknown as Record<string, unknown>).clarificationRequest).toBeUndefined();
        expect((normalized as unknown as Record<string, unknown>).uploadRequest).toBeUndefined();
    });

    it('leaves an already-normalized message untouched (idempotent)', () => {
        const m = message({ clarificationRequests: [clarification('c-1', 'pending')] });

        const [once] = normalizeMessages([m]);
        const [twice] = normalizeMessages([once]);

        expect(once).toBe(m);
        expect(twice.clarificationRequests).toEqual([clarification('c-1', 'pending')]);
    });

    it('prefers an existing list over a singular field', () => {
        const raw = [{
            ...message({ clarificationRequests: [clarification('c-1', 'answered'), clarification('c-2', 'pending')] }),
            clarificationRequest: clarification('c-2', 'pending'),
        } as unknown as Message];

        expect(normalizeMessages(raw)[0].clarificationRequests).toHaveLength(2);
    });
});

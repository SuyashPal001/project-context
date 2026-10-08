'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Message } from '@/components/platform/chat/types';

const POLL_MS = 3000;
const GIVE_UP_MS = 10 * 60 * 1000;

/**
 * A card answered on a page with no open stream (after a reload) is still
 * answered: the orchestrator carries the turn on with nobody watching and
 * saves its reply (chatStream.ts, detached turns). This page has no stream to
 * hear it on, so it re-reads the chat every few seconds until a new reply or
 * card from Olmo lands, and says Olmo is working meanwhile (2026-10-09: the
 * Pebbi earbuds plan was made after a reload and never shown).
 */
export function useDetachedReplyWatch(conversationId: string | null | undefined, messages: Message[], queryClient: QueryClient) {
    const [watching, setWatching] = useState(false);
    const knownIds = useRef<Set<string>>(new Set());
    const startedAt = useRef(0);

    const watch = useCallback(() => {
        knownIds.current = new Set(messages.map(m => m.id));
        startedAt.current = Date.now();
        setWatching(true);
    }, [messages]);

    // Stops once Olmo has said something new.
    useEffect(() => {
        if (!watching) return;
        if (messages.some(m => m.role === 'assistant' && !knownIds.current.has(m.id))) setWatching(false);
    }, [watching, messages]);

    useEffect(() => {
        if (!watching || !conversationId) return;
        const id = setInterval(() => {
            if (Date.now() - startedAt.current > GIVE_UP_MS) { setWatching(false); return; }
            queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
        }, POLL_MS);
        return () => clearInterval(id);
    }, [watching, conversationId, queryClient]);

    // A different chat is a different wait.
    useEffect(() => { setWatching(false); }, [conversationId]);

    return { watching, watch };
}

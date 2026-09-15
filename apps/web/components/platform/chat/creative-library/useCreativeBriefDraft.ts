import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { parseCreativeBriefDraft } from './creativeBrief';
import { createEmptyCreativeBrief, type CreativeBrief } from './creativeBriefModel';

interface DraftState {
    storageKey: string | null;
    brief: CreativeBrief;
}

export function useCreativeBriefDraft(storageKey: string): {
    creativeBrief: CreativeBrief;
    setCreativeBrief: Dispatch<SetStateAction<CreativeBrief>>;
    clearCreativeBrief: () => void;
} {
    const [state, setState] = useState<DraftState>(() => ({ storageKey: null, brief: createEmptyCreativeBrief() }));

    useEffect(() => {
        let cancelled = false;
        // Defer browser-only hydration until after this effect has subscribed.
        // Strict Mode can cancel its first effect pass without either writing an
        // empty draft or committing stale data from a previous tenant key.
        queueMicrotask(() => {
            if (!cancelled) setState({ storageKey, brief: parseCreativeBriefDraft(sessionStorage.getItem(storageKey)) });
        });
        return () => { cancelled = true; };
    }, [storageKey]);

    useEffect(() => {
        if (state.storageKey !== storageKey) return;
        sessionStorage.setItem(storageKey, JSON.stringify(state.brief));
    }, [state, storageKey]);

    const setCreativeBrief = useCallback<Dispatch<SetStateAction<CreativeBrief>>>((next) => {
        setState(current => ({
            storageKey,
            brief: typeof next === 'function' ? next(current.brief) : next,
        }));
    }, [storageKey]);

    const clearCreativeBrief = useCallback(() => {
        sessionStorage.removeItem(storageKey);
        setState({ storageKey: null, brief: createEmptyCreativeBrief() });
    }, [storageKey]);

    return { creativeBrief: state.brief, setCreativeBrief, clearCreativeBrief };
}

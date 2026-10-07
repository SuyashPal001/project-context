import { extractResultFiles } from "./ToolCallCard";
import type { CompletedToolCall, LiveStep, Message } from "./types";

// A picture or clip belongs to the part of the turn that made it: a later
// part never shows it again, whatever event carried it there (2026-10-07:
// the Scene 1 still from part 1 showed as "Image generated" in part 2, which
// made nothing). show_files is left alone — showing an earlier file again is
// what it is for.

/** The files an assistant part made: its attachments, its calls' results and its steps' files. */
export function madeFileIds(message: Message): string[] {
    if (message.role !== 'assistant') return [];
    const ids = (message.attachments ?? []).flatMap(a => (a.fileId ? [a.fileId] : []));
    for (const tc of message.completedTrace?.toolCalls ?? []) {
        if (tc.toolName !== 'show_files') ids.push(...extractResultFiles(tc.toolName, tc.result).map(f => f.fileId));
    }
    for (const s of message.completedTrace?.steps ?? []) ids.push(...(s.files ?? []).map(f => f.fileId));
    return ids;
}

/** For each message, the files the parts before it made; `all` is every file made so far. */
export function filesMadeBefore(messages: Message[]): { before: Set<string>[]; all: Set<string> } {
    const all = new Set<string>();
    const before = messages.map(m => {
        const snapshot = new Set(all);
        if (!m.isStreaming) for (const id of madeFileIds(m)) all.add(id);
        return snapshot;
    });
    return { before, all };
}

/** Calls whose every made file was already made by an earlier part are dropped. */
export function withoutCallsMadeEarlier<T extends Pick<CompletedToolCall, 'toolName' | 'result'>>(calls: T[], earlier: Set<string>): T[] {
    if (earlier.size === 0) return calls;
    return calls.filter(tc => {
        if (tc.toolName === 'show_files') return true;
        const files = extractResultFiles(tc.toolName, tc.result);
        return files.length === 0 || files.some(f => !earlier.has(f.fileId));
    });
}

/** Steps keep their rows; only files an earlier part made come off them. */
export function withoutStepFilesMadeEarlier(steps: LiveStep[], earlier: Set<string>): LiveStep[] {
    if (earlier.size === 0 || !steps.some(s => s.files?.some(f => earlier.has(f.fileId)))) return steps;
    return steps.map(s => (s.files?.some(f => earlier.has(f.fileId)) ? { ...s, files: s.files.filter(f => !earlier.has(f.fileId)) } : s));
}

/** The message as its part should show it: same object when nothing came from an earlier part. */
export function withoutFilesMadeEarlier(message: Message, earlier: Set<string>): Message {
    const trace = message.completedTrace;
    if (!trace || earlier.size === 0 || message.role !== 'assistant') return message;
    const toolCalls = trace.toolCalls && withoutCallsMadeEarlier(trace.toolCalls, earlier);
    const steps = trace.steps && withoutStepFilesMadeEarlier(trace.steps, earlier);
    if (toolCalls?.length === trace.toolCalls?.length && steps === trace.steps) return message;
    return { ...message, completedTrace: { ...trace, ...(toolCalls ? { toolCalls } : {}), ...(steps ? { steps } : {}) } };
}

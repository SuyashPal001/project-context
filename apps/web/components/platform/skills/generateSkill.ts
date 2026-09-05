// Talks to the agent-orchestrator directly, the same way chat and schedules do
// — not through /api/proxy, which is the API Lambda's path. Auth is the
// non-httpOnly platform_id_token cookie carried as a Bearer token, matching
// scheduled/orchestratorClient.ts.

const ORCHESTRATOR_BASE =
    process.env.NEXT_PUBLIC_AGENT_WS_URL?.replace(/^wss?:\/\//, 'https://')
    ?? 'https://agent-orchestrator.projectcontext.co';

export interface GenerateSkillInput {
    name: string;
    description?: string;
    brief: string;
    previousDraft?: string;
    feedback?: string;
}

export interface GenerateSkillHandlers {
    onDelta: (text: string) => void;
    signal?: AbortSignal;
}

export class SkillGenerationError extends Error {
    constructor(message: string, public code: 'UNAUTHORIZED' | 'NO_CREDITS' | 'FAILED') {
        super(message);
        this.name = 'SkillGenerationError';
    }
}

function getIdToken(): string {
    if (typeof document === 'undefined') return '';
    return document.cookie.split('; ').find((r) => r.startsWith('platform_id_token='))?.split('=')[1] ?? '';
}

/**
 * Streams a generated SKILL.md, calling onDelta with each chunk, and resolves
 * with the full draft. Rejects with a SkillGenerationError carrying a code the
 * dialog can turn into copy.
 */
export async function generateSkill(
    input: GenerateSkillInput,
    { onDelta, signal }: GenerateSkillHandlers,
): Promise<string> {
    const res = await fetch(`${ORCHESTRATOR_BASE}/api/skills/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getIdToken()}` },
        body: JSON.stringify(input),
        signal,
    });

    if (res.status === 401) throw new SkillGenerationError('Session expired — sign in again.', 'UNAUTHORIZED');
    if (res.status === 402) throw new SkillGenerationError('Not enough credits to generate a skill.', 'NO_CREDITS');
    if (!res.ok || !res.body) throw new SkillGenerationError('Generation failed. Try again.', 'FAILED');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let draft = '';
    let streamError: SkillGenerationError | null = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; anything after the last \n\n is
        // a partial frame and stays in the buffer until the rest arrives.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');

            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!eventLine || !dataLine) continue;

            const event = eventLine.slice(7).trim();
            let data: Record<string, unknown>;
            try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }

            if (event === 'delta' && typeof data.text === 'string') {
                draft += data.text;
                onDelta(data.text);
            } else if (event === 'error') {
                streamError = new SkillGenerationError(
                    typeof data.message === 'string' ? data.message : 'Generation failed. Try again.',
                    'FAILED',
                );
            }
        }
    }

    // Flush any bytes the decoder held back for a multi-byte character split
    // across the final chunk boundary, so it isn't silently dropped.
    buffer += decoder.decode();

    if (streamError) throw streamError;
    return draft;
}

import type { ClarificationAnswer, ClarificationRequest } from './types';

/**
 * Turns the answers a user gave on a clarification card that has already
 * expired server-side into a plain chat message, so a late answer is sent as
 * the user's next turn instead of being lost. One line per answered question:
 * "<question> — <answer>". Skipped and unanswered questions are left out.
 * Returns null when nothing was answered.
 */
export function expiredClarificationMessage(
    request: Pick<ClarificationRequest, 'questions'>,
    answers: Record<number, ClarificationAnswer>,
): string | null {
    const lines: string[] = [];
    request.questions.forEach((question, index) => {
        const answer = answers[index];
        if (!answer || answer.skipped) return;
        const parts: string[] = [];
        if (answer.selectedIndices?.length) {
            parts.push(answer.selectedIndices.map((i) => question.options[i]?.label).filter(Boolean).join(', '));
        } else if (answer.selectedIndex !== undefined) {
            const label = question.options[answer.selectedIndex]?.label;
            if (label) parts.push(label);
        }
        if (answer.freeText?.trim()) parts.push(answer.freeText.trim());
        const text = parts.filter(Boolean).join(' — ');
        if (text) lines.push(`${question.prompt} — ${text}`);
    });
    return lines.length > 0 ? lines.join('\n') : null;
}

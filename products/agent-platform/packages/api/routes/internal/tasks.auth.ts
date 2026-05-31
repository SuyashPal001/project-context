import { timingSafeEqual } from 'crypto';

export const MAX_CLARIFICATION_ROUNDS = 3;

export function isAuthorized(provided: string): boolean {
    const expected = process.env.INTERNAL_SERVICE_KEY;
    if (!expected) return false;
    try {
        return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
        return false;
    }
}

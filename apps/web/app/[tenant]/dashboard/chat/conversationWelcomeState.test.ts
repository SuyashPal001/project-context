import { describe, expect, it } from 'vitest';
import { shouldShowConversationWelcome } from './conversationWelcomeState';

describe('shouldShowConversationWelcome', () => {
    it('does not flash the welcome screen during a staged first-message handoff', () => {
        expect(shouldShowConversationWelcome({
            hasSentFirstMessage: false,
            messageCount: 0,
            isLoadingMessages: false,
            hasPendingFirstMessage: true,
        })).toBe(false);
    });

    it('shows the welcome screen for a genuinely empty conversation', () => {
        expect(shouldShowConversationWelcome({
            hasSentFirstMessage: false,
            messageCount: 0,
            isLoadingMessages: false,
            hasPendingFirstMessage: false,
        })).toBe(true);
    });
});

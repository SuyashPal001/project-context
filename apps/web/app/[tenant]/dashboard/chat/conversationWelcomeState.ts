export function shouldShowConversationWelcome({
    hasSentFirstMessage,
    messageCount,
    isLoadingMessages,
    hasPendingFirstMessage,
}: {
    hasSentFirstMessage: boolean;
    messageCount: number;
    isLoadingMessages: boolean;
    hasPendingFirstMessage: boolean;
}): boolean {
    return !hasSentFirstMessage
        && messageCount === 0
        && !isLoadingMessages
        && !hasPendingFirstMessage;
}

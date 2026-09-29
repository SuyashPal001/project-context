/**
 * Reads `?skill=<id>&skillName=<name>` alongside a seeded `?prompt=` (from
 * OfficialSkillDetail's Start button, or SkillDetailModal's Test-in-chat —
 * though that one doesn't set these), so the auto-sent first message can
 * carry `skillsUsed: [{ id, name }]` — the same shape ChatInput's "/" skill
 * picker already attaches via useChatStream.sendMessage's third argument.
 * Returns undefined (not an empty array) when either param is missing, so
 * callers can pass the result straight through to sendMessage's optional
 * third argument.
 */
export function seededSkillsUsedFromParams(
    searchParams: URLSearchParams,
): Array<{ id: string; name: string }> | undefined {
    const skillId = searchParams.get("skill");
    const skillName = searchParams.get("skillName");
    if (!skillId || !skillName) return undefined;
    return [{ id: skillId, name: skillName }];
}

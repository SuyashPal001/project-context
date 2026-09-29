/**
 * Guards the "Create with AI" avatar handler against a double click across
 * its async install (resolveCreateAvatarSkillsUsed hits POST
 * /skills/:id/install before sending). Without this, a second click while
 * the first install is still in flight installs the skill twice and sends
 * two messages / opens two chats (two handleNewChat calls at the
 * pre-conversation site).
 *
 * `getInFlight`/`setInFlight` let the caller own its own ref+state: a ref for
 * a synchronous re-entrancy check that doesn't wait on a React re-render, and
 * state so the result can be OR'd into `createAvatarDisabled` and reflected
 * in the UI. In-flight is set before `run`'s await starts and cleared in a
 * `finally`, so it clears even if `run` throws.
 */
export async function runCreateAvatarOnce(
    getInFlight: () => boolean,
    setInFlight: (value: boolean) => void,
    run: () => Promise<void>,
): Promise<void> {
    if (getInFlight()) return;
    setInFlight(true);
    try {
        await run();
    } finally {
        setInFlight(false);
    }
}

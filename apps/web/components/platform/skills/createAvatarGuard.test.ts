import { describe, it, expect, vi } from "vitest";
import { runCreateAvatarOnce } from "./createAvatarGuard";

describe("runCreateAvatarOnce", () => {
    it("runs the callback and toggles in-flight on then off", async () => {
        const seen: boolean[] = [];
        let inFlight = false;
        const setInFlight = vi.fn((v: boolean) => {
            inFlight = v;
            seen.push(v);
        });

        await runCreateAvatarOnce(() => inFlight, setInFlight, async () => {
            expect(inFlight).toBe(true); // set before the await, not after
        });

        expect(seen).toEqual([true, false]);
    });

    it("does not run a second call while the first is still in flight", async () => {
        let inFlight = false;
        const setInFlight = (v: boolean) => { inFlight = v; };
        let resolveFirst: () => void = () => {};
        const first = runCreateAvatarOnce(
            () => inFlight,
            setInFlight,
            () => new Promise<void>((resolve) => { resolveFirst = resolve; }),
        );

        const run2 = vi.fn(async () => {});
        await runCreateAvatarOnce(() => inFlight, setInFlight, run2);
        expect(run2).not.toHaveBeenCalled();

        resolveFirst();
        await first;
        expect(inFlight).toBe(false);
    });

    it("clears in-flight even when the callback throws", async () => {
        let inFlight = false;
        const setInFlight = (v: boolean) => { inFlight = v; };

        await expect(
            runCreateAvatarOnce(() => inFlight, setInFlight, async () => { throw new Error("boom"); }),
        ).rejects.toThrow("boom");

        expect(inFlight).toBe(false);
    });
});

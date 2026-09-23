/** @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { listenForWebGLContextLoss } from "./webgl-context";

describe("listenForWebGLContextLoss", () => {
    it("reports context loss, prevents the default, and cleans up", () => {
        const canvas = document.createElement("canvas");
        const onContextLost = vi.fn();
        const cleanup = listenForWebGLContextLoss(canvas, onContextLost);
        const firstEvent = new Event("webglcontextlost", { cancelable: true });

        canvas.dispatchEvent(firstEvent);
        expect(firstEvent.defaultPrevented).toBe(true);
        expect(onContextLost).toHaveBeenCalledOnce();

        cleanup();
        canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
        expect(onContextLost).toHaveBeenCalledOnce();
    });
});

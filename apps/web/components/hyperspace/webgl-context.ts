export function listenForWebGLContextLoss(
    canvas: HTMLCanvasElement,
    onContextLost: () => void,
) {
    const handleContextLost = (event: Event) => {
        event.preventDefault();
        onContextLost();
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    return () => canvas.removeEventListener("webglcontextlost", handleContextLost);
}

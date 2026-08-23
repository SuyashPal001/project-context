import { useEffect } from "react";

export function useOutsideClick(
    ref: React.RefObject<HTMLElement | null>,
    callback: (event: MouseEvent | TouchEvent) => void
) {
    useEffect(() => {
        const listener = (event: MouseEvent | TouchEvent) => {
            const target = event.target as Node;
            if (!ref.current || ref.current.contains(target)) return;
            callback(event);
        };

        document.addEventListener("mousedown", listener);
        document.addEventListener("touchstart", listener);

        return () => {
            document.removeEventListener("mousedown", listener);
            document.removeEventListener("touchstart", listener);
        };
    }, [ref, callback]);
}

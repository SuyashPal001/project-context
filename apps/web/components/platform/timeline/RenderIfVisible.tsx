'use client';
import { useRef, useState, useEffect, type ReactNode } from 'react';

interface Props {
    children: ReactNode;
    height: number;
    /** Pre-render rows this many px before they enter the viewport */
    offset?: number;
}

/**
 * Renders children only when the element is (or is near) the viewport.
 * Uses IntersectionObserver — no library dependency.
 * Once visible, stays rendered (avoids content flash on scroll-back).
 */
export function RenderIfVisible({ children, height, offset = 200 }: Props) {
    const placeholderRef = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const el = placeholderRef.current;
        if (!el) return;
        if (isVisible) return; // already visible, skip re-observing

        const observer = new IntersectionObserver(
            ([entry]) => { if (entry.isIntersecting) setIsVisible(true); },
            { rootMargin: `${offset}px 0px` },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [offset, isVisible]);

    return (
        <div ref={placeholderRef} style={{ minHeight: height }}>
            {isVisible ? children : null}
        </div>
    );
}

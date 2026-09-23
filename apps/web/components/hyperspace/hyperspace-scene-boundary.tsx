"use client";

import dynamic from "next/dynamic";
import { Component, type CSSProperties, type ErrorInfo, type ReactNode, useCallback, useEffect, useState } from "react";
import { HYPERSPACE_MEDIA } from "./media-manifest";
import { selectHyperspaceQuality, type HyperspaceQualityTier } from "./quality-tier";

const HyperspaceScene = dynamic(() => import("./hyperspace-scene"), {
    ssr: false,
    loading: () => null,
});

interface HyperspaceSceneBoundaryProps {
    arriving: boolean;
    visualTheme: "light" | "dark";
}

interface SceneErrorBoundaryProps {
    children: ReactNode;
    visualTheme: "light" | "dark";
}

interface SceneErrorBoundaryState {
    failed: boolean;
}

class SceneErrorBoundary extends Component<SceneErrorBoundaryProps, SceneErrorBoundaryState> {
    state: SceneErrorBoundaryState = { failed: false };

    static getDerivedStateFromError(): SceneErrorBoundaryState {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("Hyperspace WebGL scene failed; using the still fallback.", error, info);
    }

    render() {
        if (this.state.failed) {
            return <HyperspaceFallback animated visualTheme={this.props.visualTheme} />;
        }
        return this.props.children;
    }
}

type Capability =
    | { status: "checking" }
    | { status: "fallback"; reducedMotion: boolean }
    | { status: "ready"; tier: HyperspaceQualityTier };

function hasWebGLSupport() {
    try {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
        context?.getExtension("WEBGL_lose_context")?.loseContext();
        return Boolean(context);
    } catch {
        return false;
    }
}

interface HyperspaceFallbackProps {
    animated: boolean;
    visualTheme: "light" | "dark";
}

const FALLBACK_CYCLE_SECONDS = 9.6;
const MIN_WEBGL_VIEWPORT_WIDTH = 720;

function HyperspaceFallback({ animated, visualTheme }: HyperspaceFallbackProps) {
    const isDark = visualTheme === "dark";
    const campaignMedia = HYPERSPACE_MEDIA.filter((item) => item.placement === "hero");
    const panels = Array.from({ length: campaignMedia.length }, (_, index) => {
        const bay = Math.floor(index / 4);
        const slot = index % 4;
        const side = slot % 2 === 0 ? -1 : 1;
        const lower = slot >= 2;
        // Interleave from both ends of the curated set so established and new
        // campaigns stay mixed while every creative appears exactly once.
        const mediaIndex = index % 2 === 0
            ? index / 2
            : campaignMedia.length - 1 - Math.floor(index / 2);
        const item = campaignMedia[mediaIndex];
        const depth = bay / 7;
        const width = 22 - depth * 18.5;
        const centerDistance = 39 - depth * 35;
        const centerX = 50 + side * centerDistance;
        const centerY = lower
            ? 73 - depth * 20 + (bay % 2 === 0 ? 2 : -2)
            : 25 + depth * 18 + (bay % 2 === 0 ? -2 : 2);

        return {
            key: `${bay}-${slot}-${item.id}`,
            item,
            style: {
                "--panel-left": `${centerX - width / 2}vw`,
                "--panel-top": `${centerY}vh`,
                "--panel-width": `${width}vw`,
                "--panel-rotate-y": `${side * (10 - depth * 6)}deg`,
                "--panel-rotate-z": `${side * (lower ? -0.65 : 0.65)}deg`,
                "--panel-opacity": `${1 - depth * 0.12}`,
                "--panel-start-x": `${side * 2.8}vw`,
                "--panel-start-y": `${lower ? 1.8 : -1.8}vh`,
                "--panel-end-x": `${side * 65}vw`,
                "--panel-end-y": `${lower ? 52 : -52}vh`,
                animationDelay: `${-(index * FALLBACK_CYCLE_SECONDS) / campaignMedia.length}s`,
                zIndex: 40 - bay,
            } as CSSProperties,
        };
    });

    return (
        <div
            aria-hidden="true"
            className={`absolute inset-0 overflow-hidden ${isDark ? "bg-[#070504]" : "bg-[#f6efe8]"}`}
        >
            <div className={`absolute inset-0 ${isDark ? "bg-[radial-gradient(ellipse_at_center,rgba(29,20,17,0.98)_0%,rgba(12,8,7,0.97)_48%,rgba(3,2,2,1)_100%)]" : "bg-[radial-gradient(ellipse_at_center,rgba(255,253,250,0.98)_0%,rgba(248,239,232,0.84)_46%,rgba(226,204,193,0.62)_100%)]"}`} />
            <div className={`absolute inset-x-[18vw] bottom-[-10vh] top-[38vh] [clip-path:polygon(42%_0,58%_0,100%_100%,0_100%)] ${isDark ? "bg-[linear-gradient(180deg,rgba(255,255,255,0)_0%,rgba(130,78,58,0.13)_100%)]" : "bg-[linear-gradient(180deg,rgba(255,255,255,0)_0%,rgba(183,151,137,0.12)_100%)]"}`} />
            {panels.map(({ key, item, style }) => (
                // A deliberate still fallback: dense, readable, and independent of WebGL.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    key={key}
                    src={item.sources.medium.src}
                    srcSet={`${item.sources.low.src} ${item.sources.low.width}w, ${item.sources.medium.src} ${item.sources.medium.width}w`}
                    sizes="(max-width: 640px) 34vw, 22vw"
                    alt=""
                    style={style}
                    decoding="async"
                    draggable={false}
                    className={`absolute h-auto select-none rounded-[10px] ${isDark ? "bg-[#1d1210] shadow-[0_14px_42px_rgba(0,0,0,0.46)]" : "bg-[#eadfd7] shadow-[0_10px_34px_rgba(83,50,37,0.11)]"} ${animated ? "hyperspace-fallback-panel left-1/2 top-1/2 w-[max(7.5rem,22vw)]" : "left-[var(--panel-left)] top-[var(--panel-top)] w-[max(7.5rem,var(--panel-width))] opacity-[var(--panel-opacity)] [transform:translateY(-50%)_perspective(900px)_rotateY(var(--panel-rotate-y))_rotateZ(var(--panel-rotate-z))]"}`}
                />
            ))}
            <div className={`absolute left-1/2 top-1/2 z-50 h-[18vh] w-[25vw] min-w-[250px] -translate-x-1/2 -translate-y-1/2 ${isDark ? "bg-[radial-gradient(ellipse_at_center,rgba(10,7,6,0.84)_0%,rgba(10,7,6,0.48)_46%,rgba(10,7,6,0)_74%)]" : "bg-[radial-gradient(ellipse_at_center,rgba(250,244,239,0.78)_0%,rgba(250,244,239,0.4)_45%,rgba(250,244,239,0)_74%)]"}`} />
            <style>{`
                @keyframes hyperspace-fallback-travel {
                    0% {
                        opacity: 0;
                        transform: translate(-50%, -50%) translate3d(var(--panel-start-x), var(--panel-start-y), 0) perspective(900px) rotateY(var(--panel-rotate-y)) rotateZ(var(--panel-rotate-z)) scale(0.1);
                    }
                    7% { opacity: 0.82; }
                    18% { opacity: 1; }
                    92% { opacity: 1; }
                    100% {
                        opacity: 0;
                        transform: translate(-50%, -50%) translate3d(var(--panel-end-x), var(--panel-end-y), 0) perspective(900px) rotateY(var(--panel-rotate-y)) rotateZ(var(--panel-rotate-z)) scale(1.18);
                    }
                }

                .hyperspace-fallback-panel {
                    animation-name: hyperspace-fallback-travel;
                    animation-duration: ${FALLBACK_CYCLE_SECONDS}s;
                    animation-timing-function: linear;
                    animation-iteration-count: infinite;
                    will-change: transform, opacity;
                }
            `}</style>
        </div>
    );
}

export function HyperspaceSceneBoundary({ arriving, visualTheme }: HyperspaceSceneBoundaryProps) {
    const [capability, setCapability] = useState<Capability>({ status: "checking" });
    const handleContextLost = useCallback(() => {
        setCapability({ status: "fallback", reducedMotion: false });
    }, []);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            const narrowViewport = window.innerWidth < MIN_WEBGL_VIEWPORT_WIDTH;
            const supportsWebGL = hasWebGLSupport();
            if (reducedMotion || narrowViewport || !supportsWebGL) {
                setCapability({ status: "fallback", reducedMotion });
                return;
            }

            setCapability({
                status: "ready",
                tier: selectHyperspaceQuality({
                    width: window.innerWidth,
                    devicePixelRatio: window.devicePixelRatio,
                    hardwareConcurrency: navigator.hardwareConcurrency,
                }),
            });
        }, 0);

        return () => window.clearTimeout(timeout);
    }, []);

    if (capability.status === "checking") {
        return null;
    }
    if (capability.status === "fallback") {
        return (
            <HyperspaceFallback
                animated={!capability.reducedMotion}
                visualTheme={visualTheme}
            />
        );
    }
    return (
        <SceneErrorBoundary visualTheme={visualTheme}>
            <HyperspaceScene
                tier={capability.tier}
                arriving={arriving}
                visualTheme={visualTheme}
                onContextLost={handleContextLost}
            />
        </SceneErrorBoundary>
    );
}

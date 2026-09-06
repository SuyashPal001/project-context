"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { buildAvatarSvg } from "@/components/platform/agents/avatar-builder/buildAvatarSvg";
import { randomizeAvatarParams } from "@/components/platform/agents/avatar-builder/avatarParams";
import { seededRng } from "../personas/PersonaAvatar";
import { OlmoMark } from "../OlmoMark";
import type { PersonaSummary } from "../personas/types";
import type { PersonaAnimationState } from "../personas/usePersonaAnimationState";

// NOTE: this canvas + its 3-state system (idle/thinking/searching, eye
// tracking, lightbulb, detective glasses) only renders when neither
// `avatarUrl` nor `persona` is set — a fresh agent with no custom avatar and
// no persona attached. Personas without an uploaded avatarUrl are common
// (see PersonaAvatar.tsx's own generated-SVG fallback), so this canvas path
// is a genuine last resort, not dead code — don't assume it "never runs".
export type OrbState = 'idle' | 'thinking' | 'searching';

interface AgentOrbProps {
    state?: OrbState;
    size?: number;
    isLoading?: boolean;
    avatarUrl?: string | null;
    /** When set and `avatarUrl` is absent, renders the same deterministic
     * generated face PersonaAvatar shows elsewhere (sidebar, header) instead
     * of falling through to the generic canvas orb below. */
    persona?: PersonaSummary | null;
    /** Drives CSS motion on the static-image branch (avatarUrl set) — kept
     * separate from `state` (the canvas's own 3-state system) so existing
     * callers passing state="idle"/"thinking" don't unexpectedly start
     * animating. Only set this where the avatar is genuinely reacting to a
     * live chat stream — the currently-streaming message row, nowhere else. */
    liveState?: PersonaAnimationState;
    /** The seeded default agent (Olmo) never gets a persona or avatarUrl —
     * it's the platform's own agent, not a per-tenant hire — so render the
     * theme-aware brand mark instead of falling through to the generic
     * canvas orb below. Checked before avatarUrl/persona so it wins even if
     * either is ever set. */
    isDefault?: boolean;
}

interface Vars {
    rot: number;
    pulsePhase: number;
    bouncePhase: number;
    bounceY: number;
    blinkTimer: number;
    blinkProgress: number;
    blinkClosing: boolean;
    eyeScanPhase: number;
    bulbOpacity: number;
    glassesY: number;
    lastTs: number;
    mouseX: number | null;
    mouseY: number | null;
    currentEyeX: number;
    currentEyeY: number;
    isHappy: boolean;
    happyTimer: number;
}

function randomBlink() { return 3000 + Math.random() * 5000; }

export function AgentOrb({ state = 'idle', size = 32, isLoading = false, avatarUrl = null, persona = null, liveState, isDefault = false }: AgentOrbProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isJumping, setIsJumping] = useState(false);
    const stateRef = useRef<OrbState>(state);
    const vars = useRef<Vars>({
        rot: 0, pulsePhase: 0, bouncePhase: 0, bounceY: 0,
        blinkTimer: randomBlink(), blinkProgress: 0, blinkClosing: false,
        eyeScanPhase: 0, bulbOpacity: 0, glassesY: -200, lastTs: 0,
        mouseX: null, mouseY: null, currentEyeX: 0, currentEyeY: 0,
        isHappy: false, happyTimer: 0
    });
    const rafId = useRef(0);

    const generatedSvg = useMemo(() => {
        if (avatarUrl || !persona) return null;
        return buildAvatarSvg(randomizeAvatarParams(seededRng(persona.id)));
    }, [avatarUrl, persona]);

    useEffect(() => { stateRef.current = state; }, [state]);

    useEffect(() => {
        if (!isLoading) return;
        const interval = setInterval(() => {
            setIsJumping(true);
            setTimeout(() => setIsJumping(false), 500);
        }, 800);
        return () => clearInterval(interval);
    }, [isLoading]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        const ctx = canvas.getContext('2d')!;
        ctx.scale(dpr, dpr);

        const showExtras = size >= 48;
        // baseCY below shifts the circle's center down by size*0.08 when
        // showExtras (room for the lightbulb/glasses above it) — at radius
        // 0.50 that shift alone pushed the bottom edge to 1.08*size, past
        // the canvas box, so it got clipped flat instead of staying
        // circular. Shrinking the radius by the same amount keeps the
        // bottom edge exactly at the box edge.
        const orbR = size * (showExtras ? 0.42 : 0.50);
        const cx = size / 2;
        const baseCY = size / 2 + (showExtras ? size * 0.08 : 0);

        function frame(ts: number) {
            const v = vars.current;
            const s = stateRef.current;
            const dt = v.lastTs ? Math.min(ts - v.lastTs, 50) : 16;
            v.lastTs = ts;
            const t = dt / 16;

            // rotation
            v.rot += (s === 'searching' ? 0.010 : s === 'thinking' ? 0.006 : 0.002) * t;

            // pulse
            v.pulsePhase += 0.02 * t;

            // idle bounce
            const bAmp = s === 'searching' ? 2.5 : s === 'thinking' ? 1.5 : 0;
            const bSpeed = s === 'searching' ? 0.055 : 0.040;
            const targetBounce = bAmp > 0 ? Math.sin(v.bouncePhase) * bAmp : 0;
            if (bAmp > 0) v.bouncePhase += bSpeed * t;
            
            v.bounceY += (targetBounce - v.bounceY) * 0.18 * t;

            // happy timer
            if (v.happyTimer > 0) {
                v.happyTimer -= dt;
                if (v.happyTimer <= 0) v.isHappy = false;
            }

            // blink
            v.blinkTimer -= dt;
            if (v.blinkTimer <= 0) { v.blinkClosing = true; v.blinkTimer = randomBlink(); }
            if (v.blinkClosing) {
                v.blinkProgress = Math.min(1, v.blinkProgress + 0.15 * t);
                if (v.blinkProgress >= 1) v.blinkClosing = false;
            } else {
                v.blinkProgress = Math.max(0, v.blinkProgress - 0.10 * t);
            }

            // eye scan (searching only, or mouse tracking)
            if (s === 'searching') v.eyeScanPhase += 0.025 * t;
            else v.eyeScanPhase *= Math.pow(0.97, t);

            let targetEyeX = s === 'searching' ? Math.sin(v.eyeScanPhase) * orbR * 0.15 : 0;
            let targetEyeY = 0;

            // Follow mouse if not searching
            if (v.mouseX !== null && v.mouseY !== null && s !== 'searching') {
                const dx = v.mouseX - cx;
                const dy = v.mouseY - (baseCY + v.bounceY);
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 0) {
                    targetEyeX = (dx / dist) * Math.min(dist * 0.06, orbR * 0.30);
                    targetEyeY = (dy / dist) * Math.min(dist * 0.06, orbR * 0.30);
                }
            }

            // Butter-smooth physics lerp for eye tracking
            v.currentEyeX += (targetEyeX - v.currentEyeX) * 0.06 * t;
            v.currentEyeY += (targetEyeY - v.currentEyeY) * 0.06 * t;

            // bulb opacity
            v.bulbOpacity += ((s === 'thinking' ? 1 : 0) - v.bulbOpacity) * 0.04 * t;

            // glasses slide (0 = on face, negative = above canvas)
            v.glassesY += ((s === 'searching' ? 0 : -size) - v.glassesY) * 0.07 * t;

            // --- draw ---
            const oCY = baseCY + v.bounceY;

            ctx.clearRect(0, 0, size, size);

            const squash = Math.sin(v.pulsePhase) * 0.04;
            const bodyW = orbR * (1 + squash);
            const bodyH = orbR * (1 - squash);

            // 2a. bioluminescent glow — drawn BEFORE body, stays behind
            ctx.save();
            ctx.globalAlpha = 0.42;
            ctx.beginPath();
            ctx.ellipse(cx, oCY, bodyW * 0.62, bodyH * 0.62, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#E69DB8';
            ctx.shadowBlur = size * 1.0;
            ctx.shadowColor = 'rgba(230, 157, 184, 0.9)';
            ctx.fill();
            ctx.restore();

            // 2b. orb body — matches SaarthiLogo.tsx's mark exactly: the same
            // rose(#E69DB8) -> peach(#F2A679) diagonal the badge icon uses,
            // not an invented palette. Deepened toward the edge for the
            // sphere's own depth/readability, which the flat logo badge
            // doesn't need.
            const grad = ctx.createRadialGradient(
                cx - orbR * 0.28, oCY - orbR * 0.32, 0,
                cx, oCY, Math.max(bodyW, bodyH),
            );
            grad.addColorStop(0,    '#fbe4ec'); // pearlescent top-left, tinted off the rose end
            grad.addColorStop(0.32, '#E69DB8'); // logo mark start — rose, the dominant hue
            grad.addColorStop(0.68, '#F2A679'); // logo mark end — peach, a thin accent band, not half the sphere
            // Near-black edge stops (an earlier revision) were tuned to blend
            // into a dark page background and instead read as a harsh black
            // ring against a light one — deep rose instead, matching the
            // logo icon's own tinted-rose mark color (#5C2230) rather than
            // going to black.
            grad.addColorStop(0.8,  '#a8506b'); // deepened rose, sphere depth
            grad.addColorStop(1,    '#5c2230'); // deep rose edge — same tint as the logo's brain glyph
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(cx, oCY, bodyW, bodyH, 0, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.restore();

            // 2c. specular glint — small soft oval at top-left, above eye zone
            ctx.save();
            const spec = ctx.createRadialGradient(
                cx - orbR * 0.22, oCY - orbR * 0.38, 0,
                cx - orbR * 0.22, oCY - orbR * 0.38, orbR * 0.26,
            );
            spec.addColorStop(0, 'rgba(255,255,255,0.22)');
            spec.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.beginPath();
            ctx.ellipse(cx - orbR * 0.22, oCY - orbR * 0.38, orbR * 0.26, orbR * 0.16, 0, 0, Math.PI * 2);
            ctx.fillStyle = spec;
            ctx.fill();
            ctx.restore();

            // 3. eyes — subtle, proportional to orb
            const eyeBaseY = oCY + orbR * 0.08 + v.currentEyeY;
            const eyeOX = orbR * 0.30;
            const eyeW = Math.max(0.5, orbR * 0.18);
            const eyeH = Math.max(0.5, orbR * 0.26 * (1 - v.blinkProgress));
            
            ctx.save();
            
            if (v.isHappy) {
                // Drawing super happy squinting eyes ^^ (simple clean arch)
                for (const ex of [cx - eyeOX, cx + eyeOX]) {
                    ctx.beginPath();
                    ctx.moveTo(ex - eyeW * 0.8, eyeBaseY + eyeH * 0.1);
                    ctx.quadraticCurveTo(ex, eyeBaseY - eyeH * 0.8, ex + eyeW * 0.8, eyeBaseY + eyeH * 0.1);
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = Math.max(2, size * 0.04);
                    ctx.lineCap = 'round';
                    ctx.shadowBlur = size * 0.04;
                    ctx.shadowColor = 'rgba(255,255,255,0.8)';
                    ctx.stroke();
                }
            } else {
                for (const ex of [cx - eyeOX + v.currentEyeX, cx + eyeOX + v.currentEyeX]) {
                    const dirMult = ex > cx ? -1 : 1;
                    
                    // Outer white sclera
                    ctx.beginPath();
                    ctx.ellipse(ex, eyeBaseY, eyeW, eyeH, 0, 0, Math.PI * 2);
                    ctx.fillStyle = '#fff';
                    ctx.fill();
                    
                    // Only draw pupils if eye isn't closed
                    if (eyeH > orbR * 0.08) {
                        // Pupil (slightly cross-eyed/inward looking is cuter)
                        const pupilX = ex + dirMult * eyeW * 0.12;
                        const pupilY = eyeBaseY - eyeH * 0.05;
                        
                        ctx.beginPath();
                        ctx.arc(pupilX, pupilY, eyeW * 0.65, 0, Math.PI * 2); // Massive pupils!
                        ctx.fillStyle = '#111';
                        ctx.fill();

                        // Cute anime-style catchlight reflection
                        ctx.beginPath();
                        ctx.arc(pupilX + eyeW * 0.22, pupilY - eyeH * 0.2, eyeW * 0.28, 0, Math.PI * 2);
                        ctx.fillStyle = '#fff';
                        ctx.fill();
                        
                        // Secondary tiny reflection
                        ctx.beginPath();
                        ctx.arc(pupilX - eyeW * 0.18, pupilY + eyeH * 0.15, eyeW * 0.10, 0, Math.PI * 2);
                        ctx.fillStyle = 'rgba(255,255,255,0.6)';
                        ctx.fill();
                    }
                }
            }
            ctx.restore();

            // 5. lightbulb — thinking, size >= 48 only
            if (showExtras && v.bulbOpacity > 0.01) {
                ctx.save();
                ctx.globalAlpha = Math.min(1, v.bulbOpacity);
                const bCY = oCY - orbR * 1.08;
                const bR = orbR * 0.22;
                ctx.shadowBlur = size * 0.15;
                ctx.shadowColor = 'rgba(255,215,60,0.9)';
                ctx.beginPath();
                ctx.arc(cx, bCY, bR, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255,215,60,0.95)';
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.strokeStyle = 'rgba(255,180,40,0.85)';
                ctx.lineWidth = Math.max(1, bR * 0.4);
                ctx.lineCap = 'round';
                for (let b = 1; b <= 2; b++) {
                    ctx.beginPath();
                    ctx.moveTo(cx - bR * 0.55, bCY + bR + b * bR * 0.45);
                    ctx.lineTo(cx + bR * 0.55, bCY + bR + b * bR * 0.45);
                    ctx.stroke();
                }
                ctx.restore();
            }

            // 6. detective glasses — searching, size >= 48 only
            if (showExtras) {
                const gOpacity = Math.max(0, 1 - Math.abs(v.glassesY) / (size * 0.45));
                if (gOpacity > 0.01) {
                    ctx.save();
                    ctx.globalAlpha = gOpacity;
                    const gY = eyeBaseY + v.glassesY * 0.35;
                    const lR = orbR * 0.22;
                    const sep = orbR * 0.29;
                    ctx.strokeStyle = 'rgba(210,210,220,0.92)';
                    ctx.lineWidth = Math.max(1.2, size * 0.032);
                    ctx.lineCap = 'round';
                    // left lens
                    ctx.beginPath();
                    ctx.arc(cx - sep, gY, lR, 0, Math.PI * 2);
                    ctx.stroke();
                    // right lens
                    ctx.beginPath();
                    ctx.arc(cx + sep, gY, lR, 0, Math.PI * 2);
                    ctx.stroke();
                    // bridge
                    ctx.beginPath();
                    ctx.moveTo(cx - sep + lR, gY);
                    ctx.lineTo(cx + sep - lR, gY);
                    ctx.stroke();
                    // left temple
                    ctx.beginPath();
                    ctx.moveTo(cx - sep - lR, gY);
                    ctx.lineTo(cx - sep - lR * 1.7, gY - lR * 0.35);
                    ctx.stroke();
                    // right temple
                    ctx.beginPath();
                    ctx.moveTo(cx + sep + lR, gY);
                    ctx.lineTo(cx + sep + lR * 1.7, gY - lR * 0.35);
                    ctx.stroke();
                    ctx.restore();
                }
            }

            rafId.current = requestAnimationFrame(frame);
        }

        rafId.current = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(rafId.current);
    }, [size]);

    // Global mouse tracking — eyes follow cursor anywhere on the page
    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            vars.current.mouseX = e.clientX - rect.left;
            vars.current.mouseY = e.clientY - rect.top;
        };
        window.addEventListener('mousemove', onMove);
        return () => window.removeEventListener('mousemove', onMove);
    }, []);

    const handleClick = () => {
        vars.current.isHappy = true;
        vars.current.happyTimer = 800; // Happy for 800ms
        vars.current.pulsePhase += Math.PI; // Invert squash/stretch instantly for impact
        
        if (!isJumping) {
            setIsJumping(true);
            setTimeout(() => setIsJumping(false), 500);
        }
    };

    if (isDefault) {
        return (
            <div
                data-persona-state={liveState}
                className="persona-avatar-motion shrink-0 flex items-center justify-center rounded-full bg-secondary text-foreground"
                style={{ width: size, height: size }}
            >
                <OlmoMark height={size * 0.5} centered />
            </div>
        );
    }

    if (avatarUrl) {
        return (
            <div
                data-persona-state={liveState}
                className="persona-avatar-motion shrink-0"
                style={{ width: size, height: size }}
            >
                <img
                    src={avatarUrl}
                    alt=""
                    className="h-full w-full rounded-full object-cover"
                />
            </div>
        );
    }

    // No uploaded avatar but a persona is attached: render the same
    // deterministic generated face PersonaAvatar shows everywhere else,
    // instead of the generic canvas orb below.
    if (generatedSvg) {
        return (
            <div
                data-persona-state={liveState}
                className="persona-avatar-motion shrink-0 rounded-full overflow-hidden [&>svg]:h-full [&>svg]:w-full"
                style={{ width: size, height: size }}
                // buildAvatarSvg only ever interpolates AvatarParams' closed enum
                // values and hex color strings — never free text — so this is not
                // an injection surface. See PersonaAvatar.tsx / avatar-builder's
                // design spec.
                dangerouslySetInnerHTML={{ __html: generatedSvg }}
            />
        );
    }

    return (
        <canvas
            ref={canvasRef}
            onClick={handleClick}
            className={cn(
                "rounded-full cursor-pointer transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                (isJumping || isLoading) ? "-translate-y-8 scale-y-105 scale-x-95" : "translate-y-0 scale-100"
            )}
            style={{ display: 'block', width: size, height: size, touchAction: 'none' }}
        />
    );
}

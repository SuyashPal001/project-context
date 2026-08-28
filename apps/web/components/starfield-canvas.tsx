"use client";

import React, { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

interface StarfieldCanvasProps {
    speedMode?: 'idle' | 'warp';
    active?: boolean;
}

export function StarfieldCanvas({ speedMode = 'warp', active = true }: StarfieldCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const { resolvedTheme } = useTheme();
    const isLight = resolvedTheme === 'light';

    useEffect(() => {
        if (!active || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        let w = canvas.width = window.innerWidth;
        let h = canvas.height = window.innerHeight;

        const resize = () => {
            w = canvas.width = window.innerWidth;
            h = canvas.height = window.innerHeight;
        };
        window.addEventListener('resize', resize);

        const starCount = 320;
        const stars = Array.from({ length: starCount }, () => ({
            x: (Math.random() - 0.5) * w * 2,
            y: (Math.random() - 0.5) * h * 2,
            z: Math.random() * w, // depth
            pz: Math.random() * w
        }));

        let speed = speedMode === 'warp' ? 1.8 : 0.2;
        let targetSpeed = speedMode === 'warp' ? 52 : 0.3;
        let animationFrame: number;

        // Slow down slightly before arrival in warp mode
        let slowDownTimeout: NodeJS.Timeout;
        if (speedMode === 'warp') {
            const slowDownDelay = 350 + 600 + 700 + 700 + 700 + 100; // right around CP5 / arrival
            slowDownTimeout = setTimeout(() => {
                targetSpeed = 0.8;
            }, slowDownDelay);
        }

        const draw = () => {
            ctx.fillStyle = isLight ? '#fafafa' : '#000';
            ctx.fillRect(0, 0, w, h);

            speed += (targetSpeed - speed) * 0.05;

            ctx.save();
            ctx.translate(w / 2, h / 2);

            for (let i = 0; i < stars.length; i++) {
                const s = stars[i];
                s.pz = s.z;
                s.z -= speed;

                if (s.z < 1) {
                    s.z = w;
                    s.pz = w;
                    s.x = (Math.random() - 0.5) * w * 2;
                    s.y = (Math.random() - 0.5) * h * 2;
                }

                const sx = (s.x / s.z) * (w / 2);
                const sy = (s.y / s.z) * (h / 2);
                const px = (s.x / s.pz) * (w / 2);
                const py = (s.y / s.pz) * (h / 2);

                const size = Math.max(0.1, (1 - s.z / w) * 2.5);
                const opacity = Math.max(0, 1 - s.z / w);

                // Rose (#E69DB8) -> peach (#F2A679), blended per-star by screen
                // position instead of one flat color, so the streaks actually
                // read as a gradient field rather than a single accent color.
                const t = Math.min(1, Math.max(0, (sx + w / 2) / w));
                const r = Math.round(230 + (242 - 230) * t);
                const g = Math.round(157 + (166 - 157) * t);
                const b = Math.round(184 + (121 - 184) * t);
                const color = isLight
                    ? `rgba(${r}, ${g}, ${b}, ${opacity * 0.85})`
                    : `rgba(${r}, ${g}, ${b}, ${opacity})`;

                const dist = Math.sqrt((sx - px) ** 2 + (sy - py) ** 2);

                if (dist > 1.5 && speed > 5) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = size;
                    ctx.beginPath();
                    ctx.moveTo(px, py);
                    ctx.lineTo(sx, sy);
                    ctx.stroke();
                } else {
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(sx, sy, size, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.restore();

            animationFrame = requestAnimationFrame(draw);
        };

        draw();

        return () => {
            cancelAnimationFrame(animationFrame);
            window.removeEventListener('resize', resize);
            if (slowDownTimeout) clearTimeout(slowDownTimeout);
        };
    }, [active, speedMode, isLight]);

    if (!active) return null;

    return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />;
}

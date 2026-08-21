// apps/web/components/platform/agents/avatar-builder/AvatarControls.tsx
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
    HEAD_SHAPES, EYE_STYLES, ACCESSORIES, MOUTH_STYLES, SKIN_COLORS, HAIR_COLORS, BACKGROUND_THEMES,
} from "./avatarParams";
import type { AvatarParams } from "./avatarParams";

const LABELS: Record<string, string> = {
    tall: "Tall", round: "Round", oval: "Compact",
    dots: "Dot Eyes", shades: "Sunglasses", visor: "Amber Visor", eyepatch: "Eyepatch",
    cybermohawk: "Cyber Mohawk", hightop: "High-Top Fade", animespikes: "Anime Spikes",
    pompadour: "Pompadour", curtainbangs: "Curtain Bangs", topknot: "Topknot",
    bikerhelmet: "Biker Helmet", bandana: "Bandana", hood: "Hood", none: "None",
    goatee: "Goatee", beard: "Beard", stubble: "Stubble", smile: "Smile",
    terracotta: "Warm Terracotta", light: "Studio Light", space: "Deep Cyber Dark",
    matrix: "Neon Matrix", transparent: "Transparent",
};

interface OptionGridProps<T extends string> {
    options: readonly T[];
    value: T;
    onChange: (value: T) => void;
}

function OptionGrid<T extends string>({ options, value, onChange }: OptionGridProps<T>) {
    return (
        <div className="flex flex-wrap gap-2">
            {options.map((option) => (
                <button
                    key={option}
                    type="button"
                    onClick={() => onChange(option)}
                    className={cn(
                        "rounded-full border px-4 py-2 text-sm",
                        option === value ? "border-primary bg-primary/10 font-medium" : "border-border"
                    )}
                >
                    {LABELS[option] ?? option}
                </button>
            ))}
        </div>
    );
}

function ColorRow({ colors, value, onChange }: { colors: readonly string[]; value: string; onChange: (color: string) => void }) {
    return (
        <div className="flex flex-wrap gap-2">
            {colors.map((color) => (
                <button
                    key={color}
                    type="button"
                    aria-label={color}
                    onClick={() => onChange(color)}
                    className={cn("h-8 w-8 rounded-full border-2", color === value ? "border-foreground" : "border-transparent")}
                    style={{ backgroundColor: color }}
                />
            ))}
        </div>
    );
}

interface AvatarControlsProps {
    params: AvatarParams;
    onChange: (params: AvatarParams) => void;
}

export function AvatarControls({ params, onChange }: AvatarControlsProps) {
    const set = <K extends keyof AvatarParams>(key: K, value: AvatarParams[K]) => onChange({ ...params, [key]: value });

    return (
        <div className="space-y-5">
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Head Shape</label>
                <OptionGrid options={HEAD_SHAPES} value={params.head} onChange={(v) => set("head", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Eyes</label>
                <OptionGrid options={EYE_STYLES} value={params.eyes} onChange={(v) => set("eyes", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Hairstyle / Headwear</label>
                <OptionGrid options={ACCESSORIES} value={params.accessory} onChange={(v) => set("accessory", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Hair Color</label>
                <ColorRow colors={HAIR_COLORS} value={params.hairColor} onChange={(v) => set("hairColor", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Facial Hair</label>
                <OptionGrid options={MOUTH_STYLES} value={params.mouth} onChange={(v) => set("mouth", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Skin Tone</label>
                <ColorRow colors={SKIN_COLORS} value={params.skinColor} onChange={(v) => set("skinColor", v)} />
            </div>
            <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Background</label>
                <OptionGrid options={BACKGROUND_THEMES} value={params.bgTheme} onChange={(v) => set("bgTheme", v)} />
            </div>
        </div>
    );
}

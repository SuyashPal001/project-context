import { Instagram, Linkedin, Music2, Sparkles, Youtube } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlannerChannel } from "./types";

export const CHANNEL_LABEL: Record<PlannerChannel, string> = {
    instagram: "Instagram",
    tiktok: "TikTok",
    youtube: "YouTube",
    linkedin: "LinkedIn",
    x: "X",
};

export const CHANNELS: PlannerChannel[] = ["instagram", "tiktok", "youtube", "linkedin", "x"];

const TILE: Record<PlannerChannel, string> = {
    instagram: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af] text-white",
    tiktok: "bg-black text-white",
    youtube: "bg-[#ff0000] text-white",
    linkedin: "bg-[#0a66c2] text-white",
    x: "bg-black text-white",
};

// A small square brand tile for a channel, or the Variations mark when no
// channel is set.
export function ChannelIcon({ channel, className }: { channel?: PlannerChannel; className?: string }) {
    const base = "flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]";
    if (!channel) {
        return (
            <span className={cn(base, "bg-primary/15 text-primary", className)} aria-label="Variations">
                <Sparkles className="h-3 w-3" />
            </span>
        );
    }
    return (
        <span className={cn(base, TILE[channel], className)} aria-label={CHANNEL_LABEL[channel]}>
            {channel === "instagram" && <Instagram className="h-3 w-3" />}
            {channel === "tiktok" && <Music2 className="h-3 w-3" />}
            {channel === "youtube" && <Youtube className="h-3 w-3" />}
            {channel === "linkedin" && <Linkedin className="h-3 w-3" />}
            {channel === "x" && <span className="text-[10px] font-bold leading-none">𝕏</span>}
        </span>
    );
}

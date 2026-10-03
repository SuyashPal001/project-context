"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { VisuallyHidden } from "radix-ui";
import { ArrowUpRight, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { startOfficialSkill } from "./startOfficialSkill";
import type { Skill } from "./types";

interface OfficialSkillDetailProps {
    skill: Skill | null;
    onOpenChange: (open: boolean) => void;
}

/** Target aspect ratio (width / height) of the media pane on desktop. */
const PANE_ASPECT = 4 / 5;
/** How far a media's natural aspect can drift from the pane's before it needs letterboxing. */
const ASPECT_TOLERANCE = 0.15;

function isCloseToPaneAspect(width: number, height: number): boolean {
    if (!width || !height) return true;
    const ratio = width / height;
    return Math.abs(ratio - PANE_ASPECT) / PANE_ASPECT <= ASPECT_TOLERANCE;
}

/**
 * Detail view for an Official skill: a media pane on the left (example image or
 * video, sharp and either filling the pane edge-to-edge via object-cover when its
 * aspect is close to the pane's, or centered via object-contain over a blurred copy
 * of itself when it isn't) and name/description/Best-for/Recreate on the right.
 * Unlike SkillDetailModal, this never fetches — the caller already has the full
 * Skill (with showcase) from the list query, and there's no install/uninstall/
 * publish/test-in-chat/files panel here at all, only Recreate.
 *
 * Renders DialogContent directly instead of ModalShell: ModalShell's shared chrome
 * bakes in a "Skill Details" muted-label header bar, which this design (no header
 * at all — the name sits in the content pane) doesn't use.
 */
export function OfficialSkillDetail({ skill, onOpenChange }: OfficialSkillDetailProps) {
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const queryClient = useQueryClient();
    const [isStarting, setIsStarting] = useState(false);
    // Default to "cover" before the media loads — portraits are the common case,
    // so this avoids a flash of letterboxing while natural dimensions are unknown.
    const [fit, setFit] = useState<"cover" | "contain">("cover");

    const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
        const img = event.currentTarget;
        setFit(isCloseToPaneAspect(img.naturalWidth, img.naturalHeight) ? "cover" : "contain");
    };

    const handleVideoLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        const video = event.currentTarget;
        setFit(isCloseToPaneAspect(video.videoWidth, video.videoHeight) ? "cover" : "contain");
    };

    const handleStart = async () => {
        if (!skill) return;
        setIsStarting(true);
        try {
            await startOfficialSkill(skill, tenantSlug, router, queryClient);
        } finally {
            setIsStarting(false);
        }
    };

    const bestFor = skill?.showcase?.bestFor ?? [];
    const imageUrl = skill?.showcase?.imageUrl;
    const videoUrl = skill?.showcase?.videoUrl;
    const showBackdrop = fit === "contain";

    return (
        <Dialog open={skill !== null} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                // No `relative`: DialogContent is `fixed` + translate-centred, and the
                // absolute close button positions against that. `sm:max-w-*` must be
                // set explicitly or the base `sm:max-w-lg` caps it at 512px.
                className="flex max-h-[90vh] w-[92vw] max-w-[960px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[960px] sm:flex-row"
            >
                {skill && (
                    <>
                        {/* Screen-reader-only title — the visible layout has no header bar. */}
                        <VisuallyHidden.Root>
                            <DialogTitle>{skill.name}</DialogTitle>
                        </VisuallyHidden.Root>

                        <DialogClose
                            aria-label="Close"
                            className="absolute right-4 top-4 z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
                        >
                            <X className="h-4 w-4" />
                        </DialogClose>

                        {/* The pane owns a 4:5 shape (440×550) instead of stretching to the text
                            column's height — a short column made it a wide box that cropped portraits. */}
                        <div className="relative h-[45vh] w-full shrink-0 overflow-hidden bg-black sm:aspect-[4/5] sm:h-auto sm:w-[440px] sm:shrink-0 sm:self-start">
                            <div className="absolute inset-0">
                                {videoUrl ? (
                                    <>
                                        {showBackdrop && imageUrl && (
                                            <>
                                                <img
                                                    src={imageUrl}
                                                    alt=""
                                                    aria-hidden="true"
                                                    role="presentation"
                                                    className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
                                                />
                                                <div className="absolute inset-0 bg-black/30" />
                                            </>
                                        )}
                                        {/* Same player as the file preview (VideoPreview): the browser's own
                                            play/pause, timeline, sound and fullscreen, with download hidden.
                                            Autoplay must start muted; it loops as a silent preview and plays
                                            once, not on repeat, after the viewer turns the sound on. */}
                                        <video
                                            src={videoUrl}
                                            poster={imageUrl}
                                            autoPlay
                                            muted
                                            loop
                                            playsInline
                                            controls
                                            controlsList="nodownload noplaybackrate noremoteplayback"
                                            disablePictureInPicture
                                            onContextMenu={(e) => e.preventDefault()}
                                            onVolumeChange={(e) => { e.currentTarget.loop = e.currentTarget.muted; }}
                                            onLoadedMetadata={handleVideoLoadedMetadata}
                                            className={cn(
                                                "relative h-full w-full",
                                                fit === "cover" ? "object-cover" : "object-contain",
                                            )}
                                        />
                                    </>
                                ) : imageUrl ? (
                                    <>
                                        {showBackdrop && (
                                            <>
                                                <img
                                                    src={imageUrl}
                                                    alt=""
                                                    aria-hidden="true"
                                                    role="presentation"
                                                    className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
                                                />
                                                <div className="absolute inset-0 bg-black/30" />
                                            </>
                                        )}
                                        <img
                                            src={imageUrl}
                                            alt={skill.name}
                                            onLoad={handleImageLoad}
                                            className={cn(
                                                "relative h-full w-full",
                                                fit === "cover" ? "object-cover" : "object-contain",
                                            )}
                                        />
                                    </>
                                ) : null}
                            </div>
                        </div>

                        {/* Content anchors to the top (level with the close button); Recreate pins to the
                            bottom edge on desktop — matches the reference layout instead of floating centred. */}
                        <div className="flex min-h-0 flex-1 flex-col p-8 sm:w-[520px] sm:p-10 sm:pt-12">
                            <h1 className="pr-10 text-3xl font-semibold tracking-tight text-foreground">
                                {skill.name}
                            </h1>

                            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                                {skill.description ?? "No description"}
                            </p>

                            {bestFor.length > 0 && (
                                <div className="mt-6 space-y-2">
                                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Best for
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {bestFor.map((tag) => (
                                            <Badge key={tag} variant="outline" className="rounded-full">
                                                {tag}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <Button
                                // foreground/background tokens, not bg-black: inverts in dark mode (white
                                // button on the dark panel) so it never disappears into the background.
                                className="mt-8 h-12 w-full rounded-xl bg-foreground text-background hover:bg-foreground/90 sm:mt-auto"
                                onClick={handleStart}
                                disabled={isStarting}
                            >
                                {isStarting ? (
                                    "Starting…"
                                ) : (
                                    <>
                                        Recreate
                                        <ArrowUpRight className="h-4 w-4" />
                                    </>
                                )}
                            </Button>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

// apps/web/components/platform/agents/avatar-builder/AvatarBuilderModal.tsx
"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { AvatarPreview } from "./AvatarPreview";
import { AvatarControls } from "./AvatarControls";
import { randomizeAvatarParams, normalizeAvatarParams } from "./avatarParams";
import type { AvatarParams } from "./avatarParams";
import { buildAvatarSvg } from "./buildAvatarSvg";
import { saveAvatarAsset } from "./saveAvatarAsset";

interface AvatarBuilderModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialParams: AvatarParams | null;
    agentName: string;
    // May return a promise — the modal awaits it before closing, so "Use This
    // Avatar" doesn't close/report success until the caller has actually
    // persisted the avatar, not just uploaded the asset to storage.
    onSave: (result: { url: string; fileId: string; params: AvatarParams }) => void | Promise<void>;
}

export function AvatarBuilderModal({ open, onOpenChange, initialParams, agentName, onSave }: AvatarBuilderModalProps) {
    const [params, setParams] = React.useState<AvatarParams>(() => normalizeAvatarParams(initialParams));
    const [isSaving, setIsSaving] = React.useState(false);

    // normalizeAvatarParams guards against a corrupted or stale-enum record
    // (see avatarParams.ts) — this is the boundary where persisted data
    // re-enters the builder, so it's where the fallback has to happen.
    //
    // Only reset on the closed->open transition, not on every initialParams
    // reference change. initialParams is form.avatarParams from the parent's
    // agent query, which gets a new object identity on every refetch (e.g.
    // window focus). Resetting on every reference change would silently
    // discard in-progress edits if the query refetches while the modal is
    // open.
    const wasOpen = React.useRef(false);
    React.useEffect(() => {
        if (open && !wasOpen.current) {
            setParams(normalizeAvatarParams(initialParams));
        }
        wasOpen.current = open;
    }, [open, initialParams]);

    const handleSave = async () => {
        setIsSaving(true);
        let uploaded: { url: string; fileId: string };
        try {
            const svg = buildAvatarSvg(params);
            const filename = `${agentName.toLowerCase().replace(/\s+/g, "_") || "agent"}_avatar.svg`;
            uploaded = await saveAvatarAsset(svg, filename);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to upload avatar");
            setIsSaving(false);
            return;
        }
        try {
            // Awaited: the caller (AgentIdentityCard) persists this to the agent
            // record here — closing before this resolves would repeat the old bug
            // where the modal reported success before anything was actually saved.
            await onSave({ ...uploaded, params });
            onOpenChange(false);
        } catch {
            // The caller's own mutation already reports this with the real API
            // error message (see AgentIdentityCard's saveAvatarMutation) — don't
            // double-toast a generic one. Leave the modal open so retrying
            // "Use This Avatar" doesn't require re-customizing everything.
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-5xl max-h-[88vh] overflow-y-auto">
                <DialogHeader className="sticky top-0 z-10 bg-background pb-4 border-b">
                    <DialogTitle>Build Avatar</DialogTitle>
                </DialogHeader>
                <div className="grid grid-cols-[auto_1fr] gap-6 items-start">
                    <div className="sticky top-24 flex flex-col items-center gap-3">
                        <AvatarPreview params={params} />
                        <Button type="button" variant="outline" size="sm" onClick={() => setParams(randomizeAvatarParams())}>
                            Roll Random
                        </Button>
                    </div>
                    <AvatarControls params={params} onChange={setParams} />
                </div>
                <DialogFooter className="sticky bottom-0 z-10 bg-background pt-4 border-t">
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleSave} disabled={isSaving}>
                        {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Use This Avatar
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

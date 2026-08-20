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
    onSave: (result: { url: string; params: AvatarParams }) => void;
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
        try {
            const svg = buildAvatarSvg(params);
            const filename = `${agentName.toLowerCase().replace(/\s+/g, "_") || "agent"}_avatar.svg`;
            const { url } = await saveAvatarAsset(svg, filename);
            onSave({ url, params });
            onOpenChange(false);
            toast.success("Avatar saved");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to save avatar");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Build Avatar</DialogTitle>
                </DialogHeader>
                <div className="grid grid-cols-[auto_1fr] gap-6">
                    <div className="flex flex-col items-center gap-3">
                        <AvatarPreview params={params} />
                        <Button type="button" variant="outline" size="sm" onClick={() => setParams(randomizeAvatarParams())}>
                            Roll Random
                        </Button>
                    </div>
                    <AvatarControls params={params} onChange={setParams} />
                </div>
                <DialogFooter>
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

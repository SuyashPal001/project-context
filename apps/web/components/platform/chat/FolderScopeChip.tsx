"use client";

import { Folder as FolderIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The last segment of a grant prefix — "projects/2026/new/" reads as "new".
 * The whole prefix is path noise the user already knows; the folder name is the
 * part that tells them what the agent can reach.
 */
export function folderDisplayName(prefix: string): string {
    const parts = prefix.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
}

interface FolderScopeChipProps {
    prefix: string;
    onRevoke: () => void;
    isRevoking?: boolean;
}

/**
 * A grant is sticky — it lasts for the whole conversation rather than one
 * message — so it has to stay visible for as long as it lasts. An invisible
 * standing permission is the thing this design set out to avoid: the user should
 * never have to remember what the agent can read.
 */
export function FolderScopeChip({ prefix, onRevoke, isRevoking }: FolderScopeChipProps) {
    if (!prefix) return null;
    const name = folderDisplayName(prefix);

    return (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary border border-border text-xs w-fit">
            <FolderIcon className="w-3 h-3 text-amber-500 fill-amber-500/20 shrink-0" />
            <span className="text-muted-foreground">Agent can read</span>
            <span className="font-medium text-foreground truncate max-w-[160px]" title={prefix}>
                {name}
            </span>
            <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 ml-0.5 text-muted-foreground hover:text-destructive shrink-0"
                title="Revoke folder access"
                onClick={onRevoke}
                disabled={isRevoking}
            >
                <X className="w-3 h-3" />
            </Button>
        </div>
    );
}

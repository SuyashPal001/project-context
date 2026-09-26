"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// Fixed viewport-relative sizing (h-dvh / sm:h-[90dvh]), not max-height, so the
// dialog never resizes itself to fit whatever content the caller renders —
// AllChatsDialog visibly shrinking between its "Active" and empty "Archived"
// tabs was this exact bug. Content that's shorter than the frame just leaves
// space in the scroll area; it never shrinks the frame around it.
const SIZE_CLASSES = {
    sm: "sm:max-w-md",
    md: "sm:max-w-2xl",
    lg: "sm:max-w-[1100px]",
} as const;

interface ModalShellProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: ReactNode;
    /** sr-only text for screen readers — the visible header has no room for a subtitle. */
    description?: string;
    size?: keyof typeof SIZE_CLASSES;
    /** Default true: the frame keeps one fixed height. Pass false for short forms
     *  that should size to their content (still capped to the viewport). */
    fixedHeight?: boolean;
    /** Rendered before the close button, e.g. a "New" action. */
    headerActions?: ReactNode;
    /** Optional bottom bar (border-t) for primary actions, e.g. Skill Details' Uninstall/Test in chat. */
    footer?: ReactNode;
    children: ReactNode;
}

/** Shared chrome for full-height content dialogs (Skill Details, All chats, …):
 *  fixed size regardless of content, small muted-label header with a circular
 *  close button, and an optional bottom action bar. Pulled out of
 *  SkillDetailModal so other dialogs get the same frame instead of
 *  reimplementing (and drifting from) it. */
export function ModalShell({ open, onOpenChange, title, description, size = "lg", fixedHeight = true, headerActions, footer, children }: ModalShellProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className={`flex max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-h-[90dvh] sm:w-[90vw] ${fixedHeight ? "h-dvh sm:h-[90dvh]" : "h-auto sm:rounded-xl"} ${SIZE_CLASSES[size]} sm:rounded-xl`}
            >
                <div className="flex items-center justify-between border-b border-border px-6 py-4 shrink-0">
                    <DialogTitle className="text-sm font-semibold text-muted-foreground">{title}</DialogTitle>
                    <div className="flex items-center gap-2">
                        {headerActions}
                        <DialogClose aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                            <X className="h-3.5 w-3.5" />
                        </DialogClose>
                    </div>
                </div>
                {description && <DialogDescription className="sr-only">{description}</DialogDescription>}

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {children}
                </div>

                {footer && (
                    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-4 sm:pb-4">
                        {footer}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

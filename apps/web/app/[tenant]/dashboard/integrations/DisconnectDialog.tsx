"use client";

import { Loader2 } from "lucide-react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { CatalogueEntry } from "./_catalogue";

interface DisconnectDialogProps {
    target: CatalogueEntry | null;
    disconnecting: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
}

export function DisconnectDialog({ target, disconnecting, onOpenChange, onConfirm }: DisconnectDialogProps) {
    return (
        <AlertDialog open={!!target} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect {target?.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        Your agent will lose access to {target?.scopes.join(', ')}.
                        You can reconnect at any time.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={disconnecting}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        onClick={onConfirm}
                        disabled={disconnecting}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                        {disconnecting ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                Disconnecting...
                            </>
                        ) : (
                            'Disconnect'
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

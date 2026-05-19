"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface DeleteWorkspaceModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workspaceName: string;
    tenantId: string;
}

export function DeleteWorkspaceModal({ open, onOpenChange, workspaceName, tenantId }: DeleteWorkspaceModalProps) {
    const [confirmName, setConfirmName] = useState("");

    const deleteMutation = useMutation({
        mutationFn: () => api.del(`/api/v1/workspaces/${tenantId}`),
        onSuccess: async () => {
            toast.success("Workspace deleted");
            await fetch("/api/auth/session", { method: "DELETE" });
            window.location.href = "/auth/login";
        },
        onError: () => {
            toast.error("Failed to delete workspace. Please try again.");
        },
    });

    const canConfirm = confirmName === workspaceName;

    const handleOpenChange = (v: boolean) => {
        if (!v) setConfirmName("");
        onOpenChange(v);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="text-destructive">Delete Workspace</DialogTitle>
                    <DialogDescription>
                        This action is permanent and cannot be undone. All workspace data —
                        members, agents, API keys, and webhooks — will be deleted.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        All workspace data will be permanently deleted.
                    </div>
                    <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                            Type <span className="font-mono font-semibold text-foreground">{workspaceName}</span> to confirm:
                        </p>
                        <Input
                            value={confirmName}
                            onChange={(e) => setConfirmName(e.target.value)}
                            placeholder={workspaceName}
                            disabled={deleteMutation.isPending}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={deleteMutation.isPending}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={() => deleteMutation.mutate()} disabled={!canConfirm || deleteMutation.isPending}>
                        {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Delete workspace
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

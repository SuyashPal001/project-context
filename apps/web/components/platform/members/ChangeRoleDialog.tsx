"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { Member, Role } from "./_types";

interface ChangeRoleDialogProps {
    member: Member;
    roles: Role[];
    isPending: boolean;
    onSubmit: (roleId: string) => void;
    onSuccess?: () => void;
}

export function ChangeRoleDialog({ member, roles, isPending, onSubmit }: ChangeRoleDialogProps) {
    const [open, setOpen] = useState(false);
    const [selectedRoleId, setSelectedRoleId] = useState(member.roleId ?? "");

    const handleOpenChange = (next: boolean) => {
        if (next) setSelectedRoleId(member.roleId ?? "");
        setOpen(next);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>
                <Badge
                    variant="outline"
                    className="text-xs cursor-pointer hover:bg-accent transition-colors"
                >
                    {member.roleName || member.roleId || "No Role"}
                </Badge>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Change Role</DialogTitle>
                    <DialogDescription>
                        Current role: <span className="font-medium text-foreground">{member.roleName || "No Role"}</span>
                    </DialogDescription>
                </DialogHeader>
                <div className="py-4">
                    <Select value={selectedRoleId} onValueChange={setSelectedRoleId}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select role" />
                        </SelectTrigger>
                        <SelectContent>
                            {roles.map((role) => (
                                <SelectItem key={role.id} value={role.id}>
                                    {role.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => {
                            onSubmit(selectedRoleId);
                            setOpen(false);
                        }}
                        disabled={isPending || selectedRoleId === member.roleId}
                    >
                        {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

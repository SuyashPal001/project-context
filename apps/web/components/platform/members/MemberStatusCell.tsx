"use client";

import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Member } from "./_types";
import { statusColors, getDisplayName } from "./_helpers";

interface MemberStatusCellProps {
    member: Member;
    isReactivating: boolean;
    onReactivate: (memberId: string) => void;
}

export function MemberStatusCell({ member, isReactivating, onReactivate }: MemberStatusCellProps) {
    if (member.status !== "suspended") {
        return (
            <Badge
                variant="outline"
                className={`text-[10px] uppercase font-bold tracking-wider ${statusColors[member.status] || ""}`}
            >
                {member.status}
            </Badge>
        );
    }

    const wasJoined = !!member.joinedAt;

    return (
        <AlertDialog>
            <AlertDialogTrigger asChild>
                {wasJoined ? (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] uppercase font-bold tracking-wider rounded-full border border-destructive/20 bg-destructive/10 text-destructive hover:bg-destructive/20 px-2 shadow-none"
                    >
                        Suspended
                    </Button>
                ) : (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] uppercase font-bold tracking-wider rounded-full border border-amber-500/20 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 px-2 shadow-none"
                    >
                        Revoked
                    </Button>
                )}
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {wasJoined ? "Reactivate Member" : "Resend Invitation"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {wasJoined
                            ? `This will restore access for ${getDisplayName(member)}.`
                            : "This will send a new invitation email to this member."}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        onClick={() => onReactivate(member.id)}
                        disabled={isReactivating}
                    >
                        {isReactivating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {wasJoined ? "Reactivate" : "Resend Invite"}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

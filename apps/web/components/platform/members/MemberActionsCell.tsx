"use client";

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

interface MemberActionsCellProps {
    member: Member;
    isPending: boolean;
    onSuspend: (memberId: string) => void;
    onReactivate: (memberId: string) => void;
}

function actionLabel(member: Member): string {
    if (member.status === "invited") return "Revoke invite";
    if (member.status === "suspended") return member.joinedAt ? "Reactivate" : "Resend Invite";
    return "Suspend";
}

function dialogTitle(member: Member): string {
    if (member.status === "invited") return "Revoke Invitation";
    if (member.status === "suspended") return member.joinedAt ? "Reactivate Member" : "Resend Invitation";
    return "Suspend Member";
}

function dialogDescription(member: Member): string {
    if (member.status === "invited") return "This will revoke their invitation. They will no longer be able to join.";
    if (member.status === "suspended") {
        return member.joinedAt
            ? "This will restore their access."
            : "This will send a new invitation email to this member.";
    }
    return "This will suspend their access immediately. They will not be able to log in until reactivated.";
}

export function MemberActionsCell({ member, isPending, onSuspend, onReactivate }: MemberActionsCellProps) {
    const isDestructive = member.status !== "suspended";

    return (
        <AlertDialog>
            <AlertDialogTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="text-xs border-2"
                    disabled={isPending}
                >
                    {actionLabel(member)}
                </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{dialogTitle(member)}</AlertDialogTitle>
                    <AlertDialogDescription>{dialogDescription(member)}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        onClick={() => {
                            if (member.status === "suspended") {
                                onReactivate(member.id);
                            } else {
                                onSuspend(member.id);
                            }
                        }}
                        className={isDestructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
                    >
                        {actionLabel(member)}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

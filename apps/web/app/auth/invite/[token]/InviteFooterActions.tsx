"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface InviteFooterActionsProps {
    isLoggedIn: boolean;
    isEmailMatch: boolean;
    isEmailMismatch: boolean;
    isNewUser: boolean;
    isExistingUser: boolean;
    isCheckingEmail: boolean;
    emailCheckPending: boolean;
    isAccepting: boolean;
    loginRedirectHref: string;
    onAccept: () => void;
    onSignOut: () => void;
    onSignInRedirect: () => void;
}

export function InviteFooterActions({
    isLoggedIn, isEmailMatch, isEmailMismatch, isCheckingEmail,
    isExistingUser, emailCheckPending, isAccepting,
    onAccept, onSignOut, onSignInRedirect,
}: InviteFooterActionsProps) {
    return (
        <>
            {isLoggedIn && isEmailMatch && (
                <Button className="w-full" onClick={onAccept} disabled={isAccepting}>
                    {isAccepting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Accept Invitation
                </Button>
            )}

            {isEmailMismatch && (
                <Button variant="outline" className="w-full" onClick={onSignOut}>
                    Sign out and use different account
                </Button>
            )}

            {!isLoggedIn && isCheckingEmail && (
                <div className="flex items-center justify-center w-full py-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mr-2" />
                    <span className="text-sm text-muted-foreground">Checking account...</span>
                </div>
            )}

            {!isLoggedIn && isExistingUser && !isCheckingEmail && (
                <Button className="w-full" onClick={onSignInRedirect}>
                    Sign in to accept
                </Button>
            )}

            {!isLoggedIn && emailCheckPending && !isCheckingEmail && (
                <Button className="w-full" onClick={onSignInRedirect}>
                    Sign in to accept
                </Button>
            )}
        </>
    );
}

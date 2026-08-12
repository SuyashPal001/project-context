"use client";

import { useState } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { signUp, confirmSignUp, resendConfirmationCode, signIn } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

import { useInvitationData } from "./useInvitationData";
import { VerifyEmailCard } from "./VerifyEmailCard";
import { CreateAccountForm } from "./CreateAccountForm";
import { InviteFooterActions } from "./InviteFooterActions";
import type { CreateAccountSchema, VerifySchema } from "./_schemas";

export default function InvitePage() {
    const router = useRouter();
    const params = useParams();
    const searchParams = useSearchParams();
    const token = params.token as string;
    const errorCode = searchParams.get("error");

    const { invite, user, emailExists, error, isLoading, isCheckingEmail, setError } =
        useInvitationData(token, errorCode);

    const [isAccepting, setIsAccepting] = useState(false);
    const [createStep, setCreateStep] = useState<"form" | "verify">("form");
    const [pendingCredentials, setPendingCredentials] = useState<{ name: string; password: string } | null>(null);
    const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
    const [resendSuccess, setResendSuccess] = useState(false);

    async function handleAccept() {
        setIsAccepting(true);
        setError(null);

        try {
            const res = await fetch(`/api/proxy/api/v1/invitations/${token}/accept`, { method: "POST" });

            if (!res.ok) {
                const data = await res.json();
                if (data.code === "EMAIL_MISMATCH") {
                    throw new Error(`You're signed in as ${user?.email} but this invite was sent to ${invite?.email}. Please sign in with the correct account.`);
                }
                throw new Error(data.error || "Failed to accept invitation");
            }

            const data = await res.json();
            await fetch("/api/auth/session", { method: "DELETE" });
            router.push(`/auth/login?invited=true&slug=${data.tenantSlug}`);
            router.refresh();
        } catch (err) {
            console.error("Accept Error:", err);
            const msg = err instanceof Error ? err.message : "An error occurred while accepting the invitation";
            setError(msg);
        } finally {
            setIsAccepting(false);
        }
    }

    async function handleCreateAccount(data: CreateAccountSchema) {
        if (!invite) return;
        setIsSubmittingCreate(true);
        setError(null);

        try {
            await signUp(data.name, invite.email, data.password);
            setPendingCredentials({ name: data.name, password: data.password });
            setCreateStep("verify");
        } catch (err) {
            console.error("SignUp error:", err);
            const msg = err instanceof Error ? err.message : "Failed to create account. Please try again.";
            setError(msg);
        } finally {
            setIsSubmittingCreate(false);
        }
    }

    async function handleVerifyAndAccept(data: VerifySchema) {
        if (!invite || !pendingCredentials) return;
        setIsSubmittingCreate(true);
        setError(null);

        try {
            await confirmSignUp(invite.email, data.code);

            const signInResult = await signIn(invite.email, pendingCredentials.password);
            if (signInResult.challenge) throw new Error("Unexpected auth challenge after sign-up");
            const { idToken, accessToken, refreshToken } = signInResult;

            const sessionRes = await fetch("/api/auth/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: idToken, accessToken, refreshToken }),
            });
            if (!sessionRes.ok) throw new Error("Failed to create session");

            const acceptRes = await fetch(`/api/proxy/api/v1/invitations/${token}/accept`, { method: "POST" });
            if (!acceptRes.ok) {
                const acceptData = await acceptRes.json();
                throw new Error(acceptData.error || "Failed to accept invitation");
            }
            const acceptData = await acceptRes.json();

            // Clear session — user must re-login to get JWT with tenantId stamped
            await fetch("/api/auth/session", { method: "DELETE" });
            router.push(`/auth/login?invited=true&slug=${acceptData.tenantSlug}`);
            router.refresh();
        } catch (err) {
            console.error("Verify+Accept error:", err);
            const msg = err instanceof Error ? err.message : "An error occurred. Please try again.";
            setError(msg);
        } finally {
            setIsSubmittingCreate(false);
        }
    }

    async function handleResendCode() {
        if (!invite) return;
        setResendSuccess(false);
        setError(null);

        try {
            await resendConfirmationCode(invite.email);
            setResendSuccess(true);
        } catch (err) {
            console.error("Resend error:", err);
            const msg = err instanceof Error ? err.message : "Failed to resend code. Please try again.";
            setError(msg);
        }
    }

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen">
                <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                <p className="text-muted-foreground">Loading invitation details...</p>
            </div>
        );
    }

    if (error && !invite) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
                <Card className="w-full max-w-md">
                    <CardHeader>
                        <CardTitle className="text-destructive">Invitation Error</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-muted-foreground">{error}</p>
                    </CardContent>
                    <CardFooter className="justify-center">
                        <Button variant="outline" onClick={() => router.push("/auth/login")}>
                            Back to login
                        </Button>
                    </CardFooter>
                </Card>
            </div>
        );
    }

    const isLoggedIn = !!user;
    const isEmailMatch = isLoggedIn && user?.email?.toLowerCase() === invite?.email?.toLowerCase();
    const isEmailMismatch = isLoggedIn && user?.email?.toLowerCase() !== invite?.email?.toLowerCase();
    const isNewUser = emailExists === false;
    const isExistingUser = emailExists === true;

    if (!isLoggedIn && isNewUser && createStep === "verify") {
        return (
            <VerifyEmailCard
                email={invite?.email ?? ""}
                isSubmitting={isSubmittingCreate}
                error={error}
                resendSuccess={resendSuccess}
                onSubmit={handleVerifyAndAccept}
                onResend={handleResendCode}
            />
        );
    }

    return (
        <div className="flex items-center justify-center min-h-screen bg-background">
            <Card className="w-full max-w-md p-2 border border-border bg-card shadow-sm">
                <CardHeader className="text-center space-y-1">
                    <CardTitle className="text-2xl font-bold">Join the Team</CardTitle>
                    <CardDescription>
                        You&apos;ve been invited to join <strong>{invite?.tenantName}</strong>
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4">
                    <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Invited by:</span>
                            <span className="font-medium text-foreground">{invite?.inviterName}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Role:</span>
                            <span className="font-medium text-foreground">{invite?.roleName}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Sent to:</span>
                            <span className="font-medium text-foreground">{invite?.email}</span>
                        </div>
                    </div>

                    {error && (
                        <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">
                            {error}
                        </div>
                    )}

                    {!isLoggedIn && isNewUser && (
                        <CreateAccountForm
                            isSubmitting={isSubmittingCreate}
                            onSubmit={handleCreateAccount}
                        />
                    )}
                </CardContent>

                <CardFooter className="flex flex-col space-y-2">
                    <InviteFooterActions
                        isLoggedIn={isLoggedIn}
                        isEmailMatch={isEmailMatch}
                        isEmailMismatch={isEmailMismatch}
                        isNewUser={isNewUser}
                        isExistingUser={isExistingUser}
                        isCheckingEmail={isCheckingEmail}
                        emailCheckPending={emailExists === null}
                        isAccepting={isAccepting}
                        loginRedirectHref={`/auth/login?redirect=/auth/invite/${token}`}
                        onAccept={handleAccept}
                        onSignOut={async () => {
                            await fetch("/api/auth/session", { method: "DELETE" });
                            router.refresh();
                        }}
                        onSignInRedirect={() => router.push(`/auth/login?redirect=/auth/invite/${token}`)}
                    />
                </CardFooter>
            </Card>
        </div>
    );
}

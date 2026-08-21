"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn, completeNewPasswordChallenge } from "@/lib/auth";
import { decodeTenantClaims } from "@/lib/tenant";

import { StarfieldCanvas } from "@/components/starfield-canvas";

import { Button } from "@/components/ui/button";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const loginSchema = z.object({
    email: z.string().email({ message: "Invalid email address" }),
    password: z.string().min(8, { message: "Password must be at least 8 characters" }),
});

const newPasswordSchema = z
    .object({
        newPassword: z.string().min(8, { message: "Password must be at least 8 characters" }),
        confirmPassword: z.string().min(8, { message: "Password must be at least 8 characters" }),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
    });

type LoginSchema = z.infer<typeof loginSchema>;
type NewPasswordSchema = z.infer<typeof newPasswordSchema>;

// Cognito account created via admin-create-user (or any other forced reset)
// returns a NEW_PASSWORD_REQUIRED challenge instead of tokens on first sign-in.
// This holds what's needed to complete that challenge once the user picks
// their own permanent password.
type PendingChallenge = { email: string; session: string };

function OpsLoginContent() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [pendingChallenge, setPendingChallenge] = useState<PendingChallenge | null>(null);

    const form = useForm<LoginSchema>({
        resolver: zodResolver(loginSchema as any),
        defaultValues: { email: "", password: "" },
    });

    const newPasswordForm = useForm<NewPasswordSchema>({
        resolver: zodResolver(newPasswordSchema as any),
        defaultValues: { newPassword: "", confirmPassword: "" },
    });

    async function establishSession(idToken: string, accessToken: string, refreshToken: string) {
        const sessionRes = await fetch("/api/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: idToken, accessToken, refreshToken }),
        });
        if (!sessionRes.ok) throw new Error("Failed to create secure session");

        const meRes = await fetch("/api/proxy/api/v1/auth/me", {
            headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!meRes.ok) throw new Error("Failed to fetch user profile");
        const me = await meRes.json();

        if (me.role !== "platform_admin") {
            await fetch("/api/auth/session", { method: "DELETE" });
            setError("Access denied. This portal is for platform administrators only.");
            return;
        }

        router.push("/ops");
        router.refresh();
    }

    async function onSubmit(data: LoginSchema) {
        setIsLoading(true);
        setError(null);

        try {
            const result = await signIn(data.email, data.password);

            if (result.challenge === "NEW_PASSWORD_REQUIRED") {
                setPendingChallenge({ email: data.email, session: result.session });
                return;
            }

            await establishSession(result.idToken, result.accessToken, result.refreshToken);
        } catch (err: any) {
            console.error("Ops login error:", err);
            setError(err.message || "Invalid email or password. Please try again.");
        } finally {
            setIsLoading(false);
        }
    }

    async function onSubmitNewPassword(data: NewPasswordSchema) {
        if (!pendingChallenge) return;
        setIsLoading(true);
        setError(null);

        try {
            const { idToken, accessToken, refreshToken } = await completeNewPasswordChallenge(
                pendingChallenge.email,
                data.newPassword,
                pendingChallenge.session
            );
            await establishSession(idToken, accessToken, refreshToken);
        } catch (err: any) {
            console.error("Ops new-password challenge error:", err);
            setError(err.message || "Could not set new password. Please try again.");
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-card">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Mission Control</h1>
                    <p className="text-sm text-muted-foreground">
                        {pendingChallenge
                            ? "Choose a new password to finish signing in"
                            : "Platform administrator access only"}
                    </p>
                </div>

                {error && (
                    <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">
                        {error}
                    </div>
                )}

                {pendingChallenge ? (
                    <Form {...newPasswordForm}>
                        <form onSubmit={newPasswordForm.handleSubmit(onSubmitNewPassword)} className="space-y-4">
                            <FormField
                                control={newPasswordForm.control}
                                name="newPassword"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>New password</FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder="••••••••"
                                                type="password"
                                                disabled={isLoading}
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <FormField
                                control={newPasswordForm.control}
                                name="confirmPassword"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Confirm new password</FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder="••••••••"
                                                type="password"
                                                disabled={isLoading}
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <Button type="submit" className="w-full" disabled={isLoading}>
                                {isLoading ? "Setting password..." : "Set password and sign in"}
                            </Button>
                        </form>
                    </Form>
                ) : (
                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <FormField
                                control={form.control}
                                name="email"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Email</FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder="name@example.com"
                                                type="email"
                                                disabled={isLoading}
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <FormField
                                control={form.control}
                                name="password"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Password</FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder="••••••••"
                                                type="password"
                                                disabled={isLoading}
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <Button type="submit" className="w-full" disabled={isLoading}>
                                {isLoading ? "Signing in..." : "Sign in"}
                            </Button>
                        </form>
                    </Form>
                )}
            </div>
        </div>
    );
}

export default function OpsLoginPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-background">
                <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-card">
                    <div className="text-center">
                        <p className="text-sm text-muted-foreground">Loading...</p>
                    </div>
                </div>
            </div>
        }>
            <OpsLoginContent />
        </Suspense>
    );
}

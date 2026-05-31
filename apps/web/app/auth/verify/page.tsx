"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { confirmSignUp, resendConfirmationCode } from "@/lib/auth";
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

const verifySchema = z.object({
    code: z.string().length(6, { message: 'Verification code must be 6 digits' }),
});

type VerifySchema = z.infer<typeof verifySchema>;

function VerifyPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const email = searchParams.get('email') || '';

    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const [resendSuccess, setResendSuccess] = useState(false);

    const form = useForm<VerifySchema>({
        resolver: zodResolver(verifySchema as any),
        defaultValues: { code: "" },
    });

    useEffect(() => {
        if (!email) {
            router.push('/auth/signup');
        }
    }, [email, router]);

    async function onSubmit(data: VerifySchema) {
        setIsLoading(true);
        setError(null);

        try {
            await confirmSignUp(email, data.code);

            // On success, redirect to login with success message
            router.push('/auth/login?verified=true');
        } catch (err: any) {
            console.error("Verification error:", err);
            setError(err.message || "Invalid verification code. Please try again.");
        } finally {
            setIsLoading(false);
        }
    }

    async function handleResendCode() {
        setIsResending(true);
        setError(null);
        setResendSuccess(false);

        try {
            await resendConfirmationCode(email);
            setResendSuccess(true);
        } catch (err: any) {
            console.error("Resend error:", err);
            setError(err.message || "Failed to resend code. Please try again.");
        } finally {
            setIsResending(false);
        }
    }

    if (!email) {
        return null;
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Verify your email</h1>
                    <p className="text-sm text-muted-foreground">
                        We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
                    </p>
                </div>

                {error && (
                    <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">
                        {error}
                    </div>
                )}

                {resendSuccess && (
                    <div className="p-3 text-sm font-medium text-green-500 bg-green-500/10 rounded-md">
                        Verification code resent successfully!
                    </div>
                )}

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="code"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Verification Code</FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder="123456"
                                            maxLength={6}
                                            disabled={isLoading}
                                            {...field}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? "Verifying..." : "Verify"}
                        </Button>
                    </form>
                </Form>

                <div className="text-center space-y-2">
                    <p className="text-sm text-muted-foreground">
                        Didn't receive the code?
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleResendCode}
                        disabled={isResending}
                    >
                        {isResending ? "Resending..." : "Resend code"}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export default function VerifyPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-background">
                <div className="w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                    <div className="text-center">
                        <p className="text-sm text-muted-foreground">Loading...</p>
                    </div>
                </div>
            </div>
        }>
            <VerifyPageContent />
        </Suspense>
    );
}

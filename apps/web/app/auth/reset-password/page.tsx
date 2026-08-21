"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { resetPassword } from "@/lib/auth";
import { StarfieldCanvas } from "@/components/starfield-canvas";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const schema = z.object({
    code: z.string().min(6, { message: "Enter the 6-digit code from your email" }),
    password: z.string().min(8, { message: "Password must be at least 8 characters" }),
    confirm: z.string(),
}).refine((d) => d.password === d.confirm, { message: "Passwords do not match", path: ["confirm"] });

type Schema = z.infer<typeof schema>;

function ResetPasswordContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const email = searchParams.get('email') ?? '';
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const form = useForm<Schema>({
        resolver: zodResolver(schema as any),
        defaultValues: { code: '', password: '', confirm: '' },
    });

    async function onSubmit(data: Schema) {
        if (!email) { setError('Missing email. Please start from the forgot password page.'); return; }
        setIsLoading(true);
        setError(null);
        try {
            await resetPassword(email, data.code, data.password);
            setDone(true);
            setTimeout(() => router.push('/auth/login'), 2000);
        } catch (err: any) {
            setError(err.message || 'Failed to reset password. Please check your code and try again.');
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-card">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Set new password</h1>
                    <p className="text-sm text-muted-foreground">
                        {done ? 'Password updated! Redirecting...' : `Enter the code sent to ${email}`}
                    </p>
                </div>

                {done && (
                    <div className="p-3 text-sm font-medium text-green-500 bg-green-500/10 rounded-md">
                        Password reset successfully. Redirecting to sign in...
                    </div>
                )}

                {error && (
                    <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">{error}</div>
                )}

                {!done && (
                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <FormField control={form.control} name="code" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Reset code</FormLabel>
                                    <FormControl>
                                        <Input placeholder="123456" disabled={isLoading} autoFocus {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            <FormField control={form.control} name="password" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>New password</FormLabel>
                                    <FormControl>
                                        <Input placeholder="••••••••" type="password" disabled={isLoading} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            <FormField control={form.control} name="confirm" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Confirm password</FormLabel>
                                    <FormControl>
                                        <Input placeholder="••••••••" type="password" disabled={isLoading} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            <Button type="submit" className="w-full" disabled={isLoading}>
                                {isLoading ? 'Updating...' : 'Set new password'}
                            </Button>
                        </form>
                    </Form>
                )}

                <p className="text-center text-sm text-muted-foreground">
                    Didn&apos;t receive the code?{' '}
                    <a href={`/auth/forgot-password?email=${encodeURIComponent(email)}`} className="text-primary hover:underline">Resend</a>
                </p>
            </div>
        </div>
    );
}

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-background">
                <div className="relative z-10 w-full max-w-md p-8 rounded-xl border border-border bg-card shadow-card">
                    <p className="text-center text-sm text-muted-foreground">Loading...</p>
                </div>
            </div>
        }>
            <ResetPasswordContent />
        </Suspense>
    );
}

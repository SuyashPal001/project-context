"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { forgotPassword } from "@/lib/auth";
import { StarfieldCanvas } from "@/components/starfield-canvas";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const schema = z.object({ email: z.string().email({ message: "Invalid email address" }) });
type Schema = z.infer<typeof schema>;

function ForgotPasswordContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    const form = useForm<Schema>({
        resolver: zodResolver(schema as any),
        defaultValues: { email: searchParams.get('email') ?? '' },
    });

    async function onSubmit(data: Schema) {
        setIsLoading(true);
        setError(null);
        try {
            await forgotPassword(data.email);
            setSent(true);
            setTimeout(() => {
                router.push(`/auth/reset-password?email=${encodeURIComponent(data.email)}`);
            }, 2000);
        } catch (err: any) {
            setError(err.message || 'Failed to send reset code. Please try again.');
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-card">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Reset password</h1>
                    <p className="text-sm text-muted-foreground">
                        {sent ? 'Code sent! Redirecting...' : "We'll email you a reset code"}
                    </p>
                </div>

                {sent && (
                    <div className="p-3 text-sm font-medium text-green-500 bg-green-500/10 rounded-md">
                        Reset code sent to your email. Redirecting to reset page...
                    </div>
                )}

                {error && (
                    <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">{error}</div>
                )}

                {!sent && (
                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            <FormField control={form.control} name="email" render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Email</FormLabel>
                                    <FormControl>
                                        <Input placeholder="name@example.com" type="email" disabled={isLoading} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )} />
                            <Button type="submit" className="w-full" disabled={isLoading}>
                                {isLoading ? 'Sending...' : 'Send reset code'}
                            </Button>
                        </form>
                    </Form>
                )}

                <p className="text-center text-sm text-muted-foreground">
                    <a href="/auth/login" className="text-primary hover:underline">Back to sign in</a>
                </p>
            </div>
        </div>
    );
}

export default function ForgotPasswordPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-background">
                <div className="relative z-10 w-full max-w-md p-8 rounded-xl border border-border bg-card shadow-card">
                    <p className="text-center text-sm text-muted-foreground">Loading...</p>
                </div>
            </div>
        }>
            <ForgotPasswordContent />
        </Suspense>
    );
}

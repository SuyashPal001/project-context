"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "@/lib/auth";
import { initiateGoogleSignIn } from "@/lib/auth-google";
import { useHyperspace } from "@/components/hyperspace-provider";
import { StarfieldCanvas } from "@/components/starfield-canvas";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { WorkspacePicker, type Workspace } from "./_workspace-picker";

type Step = 'email' | 'password' | 'google';

const emailSchema = z.object({ email: z.string().email({ message: "Invalid email address" }) });
const passwordSchema = z.object({ password: z.string().min(8, { message: "Password must be at least 8 characters" }) });
type EmailSchema = z.infer<typeof emailSchema>;
type PasswordSchema = z.infer<typeof passwordSchema>;

function LoginPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { startHyperspace, finishHyperspace } = useHyperspace();
    const redirectParam = searchParams.get('redirect') || undefined;

    const [step, setStep] = useState<Step>('email');
    const [email, setEmail] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
    const [pendingTokens, setPendingTokens] = useState<{ idToken: string; refreshToken: string; accessToken: string } | null>(null);

    useEffect(() => {
        const slug = searchParams.get('slug');
        if (searchParams.get('onboarded') === 'true' && slug)
            setSuccessMessage(`Workspace created! Please log in to access ${slug}.`);
        else if (searchParams.get('invited') === 'true' && slug)
            setSuccessMessage(`Invitation accepted! Please log in again to access ${slug}.`);
    }, [searchParams]);

    const emailForm = useForm<EmailSchema>({ resolver: zodResolver(emailSchema as any), defaultValues: { email: '' } });
    const passwordForm = useForm<PasswordSchema>({ resolver: zodResolver(passwordSchema as any), defaultValues: { password: '' } });

    async function onEmailSubmit(data: EmailSchema) {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/proxy/api/v1/auth/check-email?email=${encodeURIComponent(data.email)}`);
            const json = await res.json();
            setEmail(data.email);
            setStep(json.provider === 'google' ? 'google' : 'password');
        } catch {
            setError('Failed to check email. Please try again.');
        } finally {
            setIsLoading(false);
        }
    }

    async function completeLogin(idToken: string, accessToken: string, refreshToken: string) {
        const sessionRes = await fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: idToken, accessToken, refreshToken }),
        });
        if (!sessionRes.ok) throw new Error('Failed to create secure session');
        const me = await (await fetch('/api/proxy/api/v1/auth/me')).json();

        if (me.role === 'platform_admin') { finishHyperspace(); router.push('/ops'); router.refresh(); return; }
        if (me.needsOnboarding || !me.slug) { finishHyperspace(); router.push('/auth/onboarding'); return; }

        const { tenants }: { tenants: Workspace[] } = await (await fetch('/api/proxy/api/v1/auth/tenants')).json();
        if (redirectParam || tenants.length <= 1) {
            finishHyperspace();
            router.push(redirectParam ?? (tenants[0]?.slug ? `/${tenants[0].slug}/dashboard` : '/auth/onboarding'));
            router.refresh();
            return;
        }
        finishHyperspace();
        setPendingTokens({ idToken, refreshToken, accessToken });
        setWorkspaces(tenants);
    }

    async function onPasswordSubmit(data: PasswordSchema) {
        setIsLoading(true);
        setError(null);
        startHyperspace('signin');
        try {
            const { idToken, accessToken, refreshToken } = await signIn(email, data.password);
            await completeLogin(idToken, accessToken, refreshToken);
        } catch (err: any) {
            finishHyperspace();
            setError(err.message || 'Invalid email or password.');
        } finally {
            setIsLoading(false);
        }
    }

    if (workspaces && pendingTokens) {
        return <WorkspacePicker workspaces={workspaces} pendingTokens={pendingTokens} />;
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Project Context</h1>
                    <p className="text-sm text-muted-foreground">
                        {step === 'email' ? 'Sign in to your account' : step === 'google' ? 'Continue with Google' : 'Enter your password'}
                    </p>
                </div>

                {successMessage && <div className="p-3 text-sm font-medium text-green-500 bg-green-500/10 rounded-md">{successMessage}</div>}
                {error && <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">{error}</div>}

                {step !== 'email' && (
                    <div className="flex items-center justify-between px-1">
                        <span className="text-sm text-muted-foreground">{email}</span>
                        <button onClick={() => { setStep('email'); setError(null); }} className="text-xs text-primary hover:underline">Change</button>
                    </div>
                )}

                {step === 'email' && (
                    <>
                        <Form {...emailForm}>
                            <form onSubmit={emailForm.handleSubmit(onEmailSubmit)} className="space-y-4">
                                <FormField control={emailForm.control} name="email" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Email</FormLabel>
                                        <FormControl><Input placeholder="name@example.com" type="email" disabled={isLoading} autoFocus {...field} /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <Button type="submit" className="w-full" disabled={isLoading}>{isLoading ? 'Checking...' : 'Continue'}</Button>
                            </form>
                        </Form>
                        <div className="relative">
                            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border" /></div>
                            <div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-2 text-muted-foreground">or</span></div>
                        </div>
                        <Button variant="outline" type="button" className="w-full" onClick={() => initiateGoogleSignIn(redirectParam)} disabled={isLoading}>
                            <svg className="mr-2 h-4 w-4" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 488 512">
                                <path fill="#4285F4" d="M488 261.8C488 403.3 391.1 504 248 504 110.8 504 0 393.2 0 256S110.8 8 248 8c66.8 0 123 24.5 166.3 64.9l-67.5 64.9C258.5 52.6 94.3 116.6 94.3 256c0 86.5 69.1 156.6 153.7 156.6 98.2 0 135-70.4 140.8-106.9H248v-85.3h236.1c2.3 12.7 3.9 24.9 3.9 41.4z" />
                            </svg>
                            Continue with Google
                        </Button>
                        <p className="text-center text-sm text-muted-foreground">Don&apos;t have an account?{' '}<a href="/auth/signup" className="text-primary hover:underline">Sign up</a></p>
                    </>
                )}

                {step === 'password' && (
                    <>
                        <Form {...passwordForm}>
                            <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="space-y-4">
                                <FormField control={passwordForm.control} name="password" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Password</FormLabel>
                                        <FormControl><Input placeholder="••••••••" type="password" disabled={isLoading} autoFocus {...field} /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <Button type="submit" className="w-full" disabled={isLoading}>{isLoading ? 'Signing in...' : 'Sign in'}</Button>
                            </form>
                        </Form>
                        <p className="text-center text-sm">
                            <a href={`/auth/forgot-password?email=${encodeURIComponent(email)}`} className="text-primary hover:underline text-sm">Forgot password?</a>
                        </p>
                    </>
                )}

                {step === 'google' && (
                    <>
                        <p className="text-center text-sm text-muted-foreground">This account uses Google Sign-In</p>
                        <Button variant="outline" type="button" className="w-full" onClick={() => initiateGoogleSignIn(redirectParam)}>
                            <svg className="mr-2 h-4 w-4" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 488 512">
                                <path fill="#4285F4" d="M488 261.8C488 403.3 391.1 504 248 504 110.8 504 0 393.2 0 256S110.8 8 248 8c66.8 0 123 24.5 166.3 64.9l-67.5 64.9C258.5 52.6 94.3 116.6 94.3 256c0 86.5 69.1 156.6 153.7 156.6 98.2 0 135-70.4 140.8-106.9H248v-85.3h236.1c2.3 12.7 3.9 24.9 3.9 41.4z" />
                            </svg>
                            Continue with Google
                        </Button>
                    </>
                )}
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-background">
                <div className="relative z-10 w-full max-w-md p-8 rounded-xl border border-border bg-card shadow-sm">
                    <p className="text-center text-sm text-muted-foreground">Loading...</p>
                </div>
            </div>
        }>
            <LoginPageContent />
        </Suspense>
    );
}

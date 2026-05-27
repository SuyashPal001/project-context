"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn, refreshSession } from "@/lib/auth";
import { initiateGoogleSignIn } from "@/lib/auth-google";
import { decodeTenantClaims } from "@/lib/tenant";

import { useHyperspace } from "@/components/hyperspace-provider";
import { StarfieldCanvas } from "@/components/starfield-canvas";
import { SaarthiLogo } from "@/components/platform/SaarthiLogo";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

interface Workspace {
    tenantId: string;
    name: string;
    slug: string;
    role: string;
    isCurrent: boolean;
}

const loginSchema = z.object({
    email: z.string().email({ message: "Invalid email address" }),
    password: z.string().min(8, { message: "Password must be at least 8 characters" }),
});

type LoginSchema = z.infer<typeof loginSchema>;

function LoginPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
    const [pendingTokens, setPendingTokens] = useState<{ idToken: string; refreshToken: string; accessToken: string } | null>(null);
    const { startHyperspace, finishHyperspace } = useHyperspace();

    // Show success message if redirected from onboarding or invitation
    useEffect(() => {
        const onboarded = searchParams.get('onboarded');
        const invited = searchParams.get('invited');
        const slug = searchParams.get('slug');

        if (onboarded === 'true' && slug) {
            setSuccessMessage(`Workspace created successfully! Please log in to access ${slug}.`);
        } else if (invited === 'true' && slug) {
            setSuccessMessage(`Invitation accepted! Please log in again to access ${slug}.`);
        }
    }, [searchParams]);

    const form = useForm<LoginSchema>({
        resolver: zodResolver(loginSchema),
        defaultValues: { email: "", password: "" },
    });

    async function onSubmit(data: LoginSchema) {
        setIsLoading(true);
        setError(null);
        startHyperspace('signin');

        try {
            // 1. Authenticate directly with Cognito — returns idToken, accessToken, refreshToken
            const { idToken, accessToken, refreshToken } = await signIn(data.email, data.password);
            const redirectParam = searchParams.get('redirect');

            // 2. Set session cookie first so subsequent proxy calls are authenticated
            const sessionRes = await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: idToken, accessToken, refreshToken }),
            });
            if (!sessionRes.ok) throw new Error('Failed to create secure session');

            // 3. Check onboarding status before anything else — new users have no tenant
            // in their JWT and must complete onboarding before accessing any tenant route
            const meRes = await fetch('/api/proxy/api/v1/auth/me', {
                headers: { Authorization: `Bearer ${idToken}` },
            });
            if (!meRes.ok) throw new Error('Failed to fetch user profile');
            const me = await meRes.json();

            // platform_admin check must come before needsOnboarding — ops admins
            // have no tenant by design so needsOnboarding would always be true for them
            if (me.role === 'platform_admin') {
                finishHyperspace();
                router.push('/ops');
                router.refresh();
                return;
            }

            if (me.needsOnboarding || !me.slug) {
                finishHyperspace();
                router.push('/auth/onboarding');
                return;
            }

            // 4. Fetch all workspaces this user belongs to
            const tenantsRes = await fetch('/api/proxy/api/v1/auth/tenants', {
                headers: { Authorization: `Bearer ${idToken}` },
            });
            if (!tenantsRes.ok) throw new Error('Failed to fetch workspaces');
            const { tenants: workspaceList }: { tenants: Workspace[] } = await tenantsRes.json();

            if (redirectParam || workspaceList.length <= 1) {
                const targetPath = redirectParam
                    ?? (workspaceList[0]?.slug ? `/${workspaceList[0].slug}/dashboard` : '/auth/onboarding');
                router.push(targetPath);
                router.refresh();
                return;
            }

            // 6. Multiple workspaces — clear animation then show picker
            finishHyperspace();
            setPendingTokens({ idToken, refreshToken, accessToken });
            setWorkspaces(workspaceList);
        } catch (err: any) {
            console.error("Login error:", err);
            finishHyperspace();
            setError(err.message || "Invalid email or password. Please try again.");
        } finally {
            setIsLoading(false);
        }
    }

    async function handleWorkspaceSelect(workspace: Workspace) {
        if (!pendingTokens) return;
        setIsLoading(true);
        setError(null);

        try {
            let { idToken, accessToken } = pendingTokens;
            const { refreshToken } = pendingTokens;

            // Picked a different workspace than what's in the JWT —
            // refresh with clientMetadata so the pre-token lambda stamps the right tenantId
            if (!workspace.isCurrent) {
                const refreshed = await refreshSession(refreshToken, { tenantId: workspace.tenantId });
                idToken = refreshed.idToken;
                accessToken = refreshed.accessToken;
            }

            const res = await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: idToken, accessToken, refreshToken }),
            });
            if (!res.ok) throw new Error('Failed to create secure session');

            startHyperspace();
            router.push(`/${workspace.slug}/dashboard`);
            router.refresh();
        } catch (err: any) {
            console.error('Workspace select error:', err);
            setError(err.message || 'Failed to select workspace. Please try again.');
        } finally {
            setIsLoading(false);
        }
    }

    if (workspaces) {
        return (
            <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
                <StarfieldCanvas speedMode="idle" />
                    <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                    <div className="text-center space-y-2">
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">Choose a workspace</h1>
                        <p className="text-sm text-muted-foreground">You belong to multiple workspaces</p>
                    </div>

                    {error && (
                        <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">
                            {error}
                        </div>
                    )}

                    <div className="space-y-3">
                        {workspaces.map((ws) => (
                            <Card
                                key={ws.tenantId}
                                className="cursor-pointer border border-border hover:border-primary transition-colors"
                                onClick={() => !isLoading && handleWorkspaceSelect(ws)}
                            >
                                <CardHeader className="pb-1 pt-4 px-4">
                                    <CardTitle className="text-base flex items-center justify-between">
                                        <span>{ws.name}</span>
                                        {ws.isCurrent && (
                                            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                                Current
                                            </span>
                                        )}
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="pb-4 px-4">
                                    <p className="text-xs text-muted-foreground capitalize">{ws.role}</p>
                                </CardContent>
                            </Card>
                        ))}
                    </div>

                    {isLoading && (
                        <p className="text-center text-sm text-muted-foreground">Signing in...</p>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                <div className="flex flex-col items-center space-y-3">
                    <SaarthiLogo variant="full" iconSize={36} />
                    <p className="text-sm text-muted-foreground">Sign in to your account</p>
                </div>

                {successMessage && (
                    <div className="p-3 text-sm font-medium text-green-500 bg-green-500/10 rounded-md">
                        {successMessage}
                    </div>
                )}

                {error && (
                    <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">
                        {error}
                    </div>
                )}

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="email"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Email</FormLabel>
                                    <FormControl>
                                        <Input placeholder="name@example.com" type="email" disabled={isLoading} {...field} />
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
                                        <Input placeholder="••••••••" type="password" disabled={isLoading} {...field} />
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

                <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-card px-2 text-muted-foreground">or</span>
                    </div>
                </div>

                <Button
                    variant="outline"
                    type="button"
                    className="w-full"
                    onClick={() => initiateGoogleSignIn(searchParams.get('redirect') || undefined)}
                    disabled={isLoading}
                >
                    <svg className="mr-2 h-4 w-4" aria-hidden="true" focusable="false" data-prefix="fab" data-icon="google" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 488 512">
                        <path fill="#4285F4" d="M488 261.8C488 403.3 391.1 504 248 504 110.8 504 0 393.2 0 256S110.8 8 248 8c66.8 0 123 24.5 166.3 64.9l-67.5 64.9C258.5 52.6 94.3 116.6 94.3 256c0 86.5 69.1 156.6 153.7 156.6 98.2 0 135-70.4 140.8-106.9H248v-85.3h236.1c2.3 12.7 3.9 24.9 3.9 41.4z"></path>
                    </svg>
                    Continue with Google
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                    Don't have an account?{' '}
                    <a href="/auth/signup" className="text-primary hover:underline">Sign up</a>
                </p>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-background">
                <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                    <div className="text-center">
                        <p className="text-sm text-muted-foreground">Loading...</p>
                    </div>
                </div>
            </div>
        }>
            <LoginPageContent />
        </Suspense>
    );
}
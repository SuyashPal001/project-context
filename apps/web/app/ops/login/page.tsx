"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "@/lib/auth";
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

type LoginSchema = z.infer<typeof loginSchema>;

function OpsLoginContent() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const form = useForm<LoginSchema>({
        resolver: zodResolver(loginSchema as any),
        defaultValues: { email: "", password: "" },
    });

    async function onSubmit(data: LoginSchema) {
        setIsLoading(true);
        setError(null);

        try {
            const { idToken, accessToken, refreshToken } = await signIn(data.email, data.password);

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
        } catch (err: any) {
            console.error("Ops login error:", err);
            setError(err.message || "Invalid email or password. Please try again.");
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Mission Control</h1>
                    <p className="text-sm text-muted-foreground">Platform administrator access only</p>
                </div>

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
            </div>
        </div>
    );
}

export default function OpsLoginPage() {
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
            <OpsLoginContent />
        </Suspense>
    );
}

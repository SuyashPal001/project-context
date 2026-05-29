"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signUp } from "@/lib/auth";
import { initiateGoogleSignIn } from "@/lib/auth-google";
import { StarfieldCanvas } from "@/components/starfield-canvas";
import { SaarthiLogo } from "@/components/platform/SaarthiLogo";

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

const signupSchema = z.object({
    name: z.string().min(1, { message: 'Name is required' }),
    email: z.string().email({ message: 'Invalid email address' }),
    password: z.string().min(8, { message: 'Password must be at least 8 characters' }),
    confirmPassword: z.string(),
}).refine(d => d.password === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
});

type SignupSchema = z.infer<typeof signupSchema>;

export default function SignupPage() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const form = useForm<SignupSchema>({
        resolver: zodResolver(signupSchema as any),
        defaultValues: {
            name: "",
            email: "",
            password: "",
            confirmPassword: "",
        },
    });

    async function onSubmit(data: SignupSchema) {
        setIsLoading(true);
        setError(null);

        try {
            await signUp(data.name, data.email, data.password);

            // On success, redirect to verification page
            router.push(`/auth/verify?email=${encodeURIComponent(data.email)}`);
        } catch (err: any) {
            console.error("Signup error:", err);
            setError(err.message || "Failed to create account. Please try again.");
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                <div className="flex flex-col items-center space-y-3">
                    <SaarthiLogo variant="full" iconSize={36} />
                    <p className="text-sm text-muted-foreground">Create your account to get started</p>
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
                            name="name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="John Doe" disabled={isLoading} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
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
                        <FormField
                            control={form.control}
                            name="confirmPassword"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Confirm Password</FormLabel>
                                    <FormControl>
                                        <Input placeholder="••••••••" type="password" disabled={isLoading} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? "Creating account..." : "Sign up"}
                        </Button>
                    </form>
                </Form>

                <p className="text-center text-sm text-muted-foreground">
                    Already have an account?{' '}
                    <a href="/auth/login" className="text-primary hover:underline">Sign in</a>
                </p>
            </div>
        </div>
    );
}

"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { verifySchema, type VerifySchema } from "./_schemas";

interface VerifyEmailCardProps {
    email: string;
    isSubmitting: boolean;
    error: string | null;
    resendSuccess: boolean;
    onSubmit: (data: VerifySchema) => void;
    onResend: () => void;
}

export function VerifyEmailCard({ email, isSubmitting, error, resendSuccess, onSubmit, onResend }: VerifyEmailCardProps) {
    const form = useForm<VerifySchema>({
        resolver: zodResolver(verifySchema as any),
        defaultValues: { code: "" },
    });

    return (
        <div className="flex items-center justify-center min-h-screen bg-background">
            <Card className="w-full max-w-md p-2 border border-border bg-card shadow-card">
                <CardHeader className="text-center space-y-1">
                    <CardTitle className="text-2xl font-bold">Verify your email</CardTitle>
                    <CardDescription>
                        We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4">
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
                                                disabled={isSubmitting}
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <Button type="submit" className="w-full" disabled={isSubmitting}>
                                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {isSubmitting ? "Verifying..." : "Verify & Accept Invitation"}
                            </Button>
                        </form>
                    </Form>
                </CardContent>

                <CardFooter className="flex flex-col space-y-2">
                    <p className="text-sm text-muted-foreground">Didn&apos;t receive the code?</p>
                    <Button variant="outline" size="sm" onClick={onResend}>
                        Resend code
                    </Button>
                </CardFooter>
            </Card>
        </div>
    );
}

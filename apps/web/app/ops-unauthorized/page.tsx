import Link from "next/link";
import { Shield } from "lucide-react";
import { StarfieldCanvas } from "@/components/starfield-canvas";

export default function OpsUnauthorizedPage() {
    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-card text-center">
                <div className="flex justify-center">
                    <div className="h-12 w-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                        <Shield className="h-6 w-6 text-red-400" />
                    </div>
                </div>
                <div className="space-y-2">
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">Access Denied</h1>
                    <p className="text-sm text-muted-foreground">
                        This portal requires the <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">platform_admin</span> role.
                        Your account does not have the necessary privileges.
                    </p>
                </div>
                <Link
                    href="/auth/login"
                    className="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                    Return to login
                </Link>
            </div>
        </div>
    );
}

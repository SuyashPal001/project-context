"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { useAuthRefresh } from "@/hooks/useAuthRefresh";
import { HyperspaceProvider } from "./hyperspace-provider";
import { PostHogProvider } from "./posthog-provider";

export default function Providers({ children }: { children: React.ReactNode }) {
    useAuthRefresh();
    const [queryClient] = useState(() => new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 60 * 1000,
            },
        },
    }));

    return (
        <PostHogProvider>
            <QueryClientProvider client={queryClient}>
                <HyperspaceProvider>
                    {children}
                </HyperspaceProvider>
            </QueryClientProvider>
        </PostHogProvider>
    );
}

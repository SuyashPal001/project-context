"use client"

import { Sidebar } from "@/components/platform/Sidebar"
import { useSidebar } from "@/components/platform/SidebarContext"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

export function SidebarContent({ children }: { children: React.ReactNode }) {
    const { isSidebarCollapsed } = useSidebar();
    const pathname = usePathname();
    const isChatPage = pathname?.includes('/dashboard/chat');

    return (
        <div className="flex min-h-screen bg-background text-foreground overflow-hidden">
            <Sidebar />

            <div className={cn(
                "flex-1 flex flex-col min-w-0 transition-all duration-300",
                isSidebarCollapsed ? "ml-16" : "ml-60"
            )}>
                <main className={cn(
                    "flex-1 overflow-y-auto custom-scrollbar",
                    !isChatPage && "p-8"
                )}>
                    <div className={cn(
                        "h-full",
                        !isChatPage && "max-w-7xl mx-auto"
                    )}>
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}

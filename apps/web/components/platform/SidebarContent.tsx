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
        <div className={cn(
            "flex bg-background text-foreground",
            isChatPage ? "h-screen overflow-hidden" : "min-h-screen"
        )}>
            <Sidebar />

            <div className={cn(
                "flex-1 flex flex-col min-w-0 transition-all duration-300",
                isChatPage && "min-h-0",
                isSidebarCollapsed ? "ml-16" : "ml-[17rem]"
            )}>
                <main className={cn(
                    isChatPage ? "flex-1 min-h-0 overflow-hidden" : "overflow-visible",
                    !isChatPage && "p-8"
                )}>
                    <div className={cn(
                        isChatPage && "h-full",
                        !isChatPage && "max-w-7xl mx-auto"
                    )}>
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}

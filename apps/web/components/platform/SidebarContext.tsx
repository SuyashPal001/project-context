"use client"

import * as React from "react"
import { useHyperspace } from "@/components/hyperspace-provider"

interface SidebarContextType {
    isSidebarCollapsed: boolean
    toggleSidebar: () => void
    collapseSidebar: () => void
    isChatSidebarCollapsed: boolean
    toggleChatSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextType | undefined>(undefined)

export function SidebarProvider({ children }: { children: React.ReactNode }) {
    const { finishHyperspace } = useHyperspace()
    const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(false)
    const [isChatSidebarCollapsed, setIsChatSidebarCollapsed] = React.useState(false)

    // Load from local storage and finish loader if active
    React.useEffect(() => {
        finishHyperspace()
        const savedGlobal = localStorage.getItem("sidebar-collapsed")
        const savedChat = localStorage.getItem("chat-sidebar-collapsed")
        if (savedGlobal === "true") setIsSidebarCollapsed(true)
        if (savedChat === "true") setIsChatSidebarCollapsed(true)
    }, [])

    const toggleSidebar = () => {
        setIsSidebarCollapsed(prev => {
            const next = !prev
            localStorage.setItem("sidebar-collapsed", String(next))
            return next
        })
    }

    // Idempotent collapse (unlike toggleSidebar) — safe to call on every Chat
    // nav click without re-expanding an already-collapsed sidebar.
    const collapseSidebar = () => {
        setIsSidebarCollapsed(prev => {
            if (prev) return prev
            localStorage.setItem("sidebar-collapsed", "true")
            return true
        })
    }

    const toggleChatSidebar = () => {
        setIsChatSidebarCollapsed(prev => {
            const next = !prev
            localStorage.setItem("chat-sidebar-collapsed", String(next))
            return next
        })
    }

    return (
        <SidebarContext.Provider value={{
            isSidebarCollapsed,
            toggleSidebar,
            collapseSidebar,
            isChatSidebarCollapsed,
            toggleChatSidebar
        }}>
            {children}
        </SidebarContext.Provider>
    )
}

export function useSidebar() {
    const context = React.useContext(SidebarContext)
    if (context === undefined) {
        throw new Error("useSidebar must be used within a SidebarProvider")
    }
    return context
}

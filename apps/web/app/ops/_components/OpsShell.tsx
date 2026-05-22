"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    LayoutDashboard, Building2, Sliders, FileText, Cpu,
    Shield, LogOut, MessageCircleQuestion,
    Star, Wrench, ChevronRight, DollarSign, List, Users, ShieldCheck,
    PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

type NavItem =
    | { kind: "link";    label: string; href: string; icon: React.ElementType }
    | { kind: "section"; label: string }
    | { kind: "sub";     label: string; href: string; icon: React.ElementType };

const NAV: NavItem[] = [
    { kind: "link",    label: "Overview",           href: "/ops",                                         icon: LayoutDashboard },
    { kind: "link",    label: "Tenants",             href: "/ops/tenants",                                 icon: Building2 },
    { kind: "section", label: "Agent Intelligence" },
    { kind: "sub",     label: "Knowledge Gaps",      href: "/ops/agent-intelligence/knowledge-gaps",       icon: MessageCircleQuestion },
    { kind: "sub",     label: "Eval Scores",         href: "/ops/agent-intelligence/eval-scores",          icon: Star },
    { kind: "sub",     label: "Eval Results",        href: "/ops/agent-intelligence/eval-results",         icon: List },
    { kind: "sub",     label: "Tool Performance",    href: "/ops/agent-intelligence/tool-performance",     icon: Wrench },
    { kind: "section", label: "Platform" },
    { kind: "sub",     label: "FinOps",              href: "/ops/finops",                                  icon: DollarSign },
    { kind: "sub",     label: "Audit Log",           href: "/ops/platform/audit",                          icon: FileText },
    { kind: "sub",     label: "Providers",           href: "/ops/platform/providers",                      icon: Cpu },
    { kind: "sub",     label: "Feature Overrides",   href: "/ops/platform/overrides",                      icon: Sliders },
    { kind: "sub",     label: "Team",                href: "/ops/team",                                    icon: Users },
    { kind: "section", label: "Compliance" },
    { kind: "sub",     label: "Fairness Reviews",    href: "/ops/fairness",                                icon: ShieldCheck },
];

export function OpsShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const [collapsed, setCollapsed] = React.useState(false);

    React.useEffect(() => {
        const saved = localStorage.getItem("ops-sidebar-collapsed");
        if (saved === "true") setCollapsed(true);
    }, []);

    const toggle = () => {
        setCollapsed(prev => {
            localStorage.setItem("ops-sidebar-collapsed", String(!prev));
            return !prev;
        });
    };

    return (
        <TooltipProvider>
            <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
                {/* Sidebar */}
                <aside className={cn(
                    "fixed inset-y-0 left-0 flex flex-col bg-[#0d0d0f] border-r border-zinc-800/60 transition-all duration-300 ease-in-out z-50",
                    collapsed ? "w-14" : "w-56"
                )}>
                    {/* Header */}
                    <div className={cn(
                        "h-14 flex items-center border-b border-zinc-800/60 flex-shrink-0",
                        collapsed ? "justify-center px-2" : "gap-2.5 px-4"
                    )}>
                        <div className="h-6 w-6 rounded-md bg-violet-500/15 border border-violet-500/30 flex items-center justify-center flex-shrink-0">
                            <Shield className="h-3.5 w-3.5 text-violet-400" />
                        </div>
                        {!collapsed && (
                            <div className="min-w-0">
                                <p className="text-[13px] font-semibold text-zinc-100 leading-none">Mission Control</p>
                                <p className="text-[10px] text-zinc-600 mt-0.5 leading-none">platform_admin</p>
                            </div>
                        )}
                    </div>

                    {/* Nav */}
                    <nav className="flex-1 px-2 py-3 overflow-y-auto space-y-0.5">
                        {NAV.map((item, i) => {
                            if (item.kind === "section") {
                                if (collapsed) return null;
                                return (
                                    <div key={i} className={cn("px-3 pt-4 pb-1", i > 0 && "mt-1")}>
                                        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">
                                            {item.label}
                                        </p>
                                    </div>
                                );
                            }

                            const active = item.kind === "link"
                                ? (item.href === "/ops" ? pathname === "/ops" : pathname === item.href || pathname.startsWith(item.href + "/"))
                                : pathname === item.href || pathname.startsWith(item.href + "/");
                            const Icon = item.icon;
                            const isSub = item.kind === "sub";

                            const linkEl = (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={cn(
                                        "flex items-center rounded-md text-[13px] font-medium transition-colors",
                                        collapsed ? "justify-center px-2 py-2" : (isSub ? "gap-2.5 px-3 py-1.5 pl-5" : "gap-2.5 px-3 py-2"),
                                        active
                                            ? "bg-zinc-800 text-zinc-50"
                                            : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50"
                                    )}
                                >
                                    <Icon className={cn("flex-shrink-0", isSub ? "h-3.5 w-3.5" : "h-4 w-4", active ? "text-zinc-300" : "text-zinc-600")} />
                                    {!collapsed && item.label}
                                </Link>
                            );

                            if (collapsed) {
                                return (
                                    <Tooltip key={item.href} delayDuration={0}>
                                        <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
                                        <TooltipContent side="right" className="ml-1">{item.label}</TooltipContent>
                                    </Tooltip>
                                );
                            }

                            return linkEl;
                        })}
                    </nav>

                    {/* Footer */}
                    <div className="px-2 pb-3 border-t border-zinc-800/60 pt-3 space-y-1">
                        {collapsed ? (
                            <Tooltip delayDuration={0}>
                                <TooltipTrigger asChild>
                                    <Link
                                        href="/auth/login"
                                        className="flex items-center justify-center px-2 py-2 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
                                    >
                                        <LogOut className="h-3.5 w-3.5" />
                                    </Link>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="ml-1">Exit Portal</TooltipContent>
                            </Tooltip>
                        ) : (
                            <Link
                                href="/auth/login"
                                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[12px] text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
                            >
                                <LogOut className="h-3.5 w-3.5" />
                                Exit Portal
                            </Link>
                        )}
                        <button
                            onClick={toggle}
                            className={cn(
                                "w-full flex items-center rounded-md py-2 text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors",
                                collapsed ? "justify-center px-2" : "gap-2.5 px-3"
                            )}
                        >
                            {collapsed
                                ? <PanelLeftOpen className="h-4 w-4" />
                                : <><PanelLeftClose className="h-4 w-4" /><span className="text-[12px]">Collapse</span></>
                            }
                        </button>
                    </div>
                </aside>

                {/* Main */}
                <div className={cn("flex-1 min-w-0 transition-all duration-300 ease-in-out", collapsed ? "ml-14" : "ml-56")}>
                    <main className="min-h-screen p-8">
                        <div className="max-w-7xl mx-auto">
                            {children}
                        </div>
                    </main>
                </div>

                <Toaster position="bottom-right" richColors theme="dark" />
            </div>
        </TooltipProvider>
    );
}

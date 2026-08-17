"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    LayoutDashboard, Building2, Sliders, FileText, Cpu,
    Shield, LogOut, MessageCircleQuestion,
    Star, Wrench, ChevronRight, DollarSign, List, Users, ShieldCheck,
    PanelLeftClose, PanelLeftOpen, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import { ThemeToggle } from "@/components/theme-toggle";
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
    { kind: "sub",     label: "Observability",       href: "/ops/observability",                           icon: Activity },
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
            <div className="flex min-h-screen bg-background text-foreground">
                {/* Sidebar */}
                <aside className={cn(
                    "fixed left-3 top-3 bottom-3 flex flex-col bg-sidebar border border-sidebar-border rounded-2xl shadow-elevated transition-all duration-300 ease-in-out z-50",
                    collapsed ? "w-14" : "w-56"
                )}>
                    {/* Header */}
                    <div className={cn(
                        "h-14 flex items-center border-b border-sidebar-border flex-shrink-0",
                        collapsed ? "justify-center px-2" : "gap-2.5 px-4"
                    )}>
                        <div className="h-6 w-6 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
                            <Shield className="h-3.5 w-3.5 text-primary" />
                        </div>
                        {!collapsed && (
                            <div className="min-w-0">
                                <p className="text-[13px] font-semibold text-sidebar-foreground leading-none">Mission Control</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5 leading-none">platform_admin</p>
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
                                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
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
                                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                            : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50"
                                    )}
                                >
                                    <Icon className={cn("flex-shrink-0", isSub ? "h-3.5 w-3.5" : "h-4 w-4", active ? "text-sidebar-accent-foreground/80" : "text-muted-foreground")} />
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
                    <div className="px-2 pb-3 border-t border-sidebar-border pt-3 space-y-1">
                        {collapsed ? (
                            <Tooltip delayDuration={0}>
                                <TooltipTrigger asChild>
                                    <Link
                                        href="/auth/login"
                                        className="flex items-center justify-center px-2 py-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50 transition-colors"
                                    >
                                        <LogOut className="h-3.5 w-3.5" />
                                    </Link>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="ml-1">Exit Portal</TooltipContent>
                            </Tooltip>
                        ) : (
                            <Link
                                href="/auth/login"
                                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50 transition-colors"
                            >
                                <LogOut className="h-3.5 w-3.5" />
                                Exit Portal
                            </Link>
                        )}
                        <ThemeToggle collapsed={collapsed} />
                        <button
                            onClick={toggle}
                            className={cn(
                                "w-full flex items-center rounded-md py-2 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50 transition-colors",
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
                <div className={cn("flex-1 min-w-0 transition-all duration-300 ease-in-out", collapsed ? "ml-[5rem]" : "ml-[15.5rem]")}>
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

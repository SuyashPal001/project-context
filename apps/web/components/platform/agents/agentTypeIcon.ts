import {
    Bot,
    ClipboardList,
    BarChart3,
    CalendarCheck2,
    Code2,
    Building2,
    Settings,
    LifeBuoy,
    CreditCard,
    type LucideIcon,
} from "lucide-react";
import type { AgentType } from "./types";

// Gives each agent role a distinct icon so a roster/list stays visually
// distinguishable without relying on per-agent color.
const AGENT_TYPE_ICONS: Record<AgentType, LucideIcon> = {
    product_manager: ClipboardList,
    analyst: BarChart3,
    project_manager: CalendarCheck2,
    tech_lead: Code2,
    architect: Building2,
    ops: Settings,
    support: LifeBuoy,
    billing: CreditCard,
    custom: Bot,
};

export function getAgentTypeIcon(type?: AgentType | null): LucideIcon {
    return (type && AGENT_TYPE_ICONS[type]) || Bot;
}

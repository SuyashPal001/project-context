import {
    Sparkles,
    FileText,
    Map,
    ListChecks,
    Search,
    Lightbulb,
    PenLine,
    HelpCircle,
    ImagePlus,
    Palette,
    LayoutTemplate,
    Music,
    BarChart3,
    Code2,
    Building2,
    CalendarCheck2,
    ClipboardList,
    Settings,
    LifeBuoy,
    CreditCard,
    type LucideIcon,
} from "lucide-react";

// Closed set of icon keys a persona's or agent-type's hand-authored (or,
// later, generated) suggested prompts may use. Extend this map when a new
// persona's pills need an icon not yet covered here — same maintenance cost
// as agentTypeIcon.ts already has for new agent types. Never render a raw
// icon-name string directly; always resolve through here so an unrecognized
// or malformed stored key degrades to Sparkles instead of rendering nothing.
const PILL_ICONS: Record<string, LucideIcon> = {
    'file-text': FileText,
    'map': Map,
    'list-checks': ListChecks,
    'search': Search,
    'lightbulb': Lightbulb,
    'pen-line': PenLine,
    'help-circle': HelpCircle,
    'image-plus': ImagePlus,
    'palette': Palette,
    'sparkles': Sparkles,
    'layout-template': LayoutTemplate,
    'music': Music,
    'bar-chart': BarChart3,
    'code': Code2,
    'building': Building2,
    'calendar': CalendarCheck2,
    'clipboard-list': ClipboardList,
    'settings': Settings,
    'life-buoy': LifeBuoy,
    'credit-card': CreditCard,
};

export function getPillIcon(key: string | null | undefined): LucideIcon {
    return (key && PILL_ICONS[key]) || Sparkles;
}

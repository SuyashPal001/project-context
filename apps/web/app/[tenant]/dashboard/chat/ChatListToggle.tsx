"use client"

import { ListTodo, PanelLeftClose } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { WORK_ITEM } from "@/components/platform/chat/workItemLabels"
import { FEATURE_FLAGS } from "@/lib/feature-flags"

// Opens/closes the chat list panel. Closed, it names the list with its own icon:
// the bare panel icon it used to show was identical to the main sidebar's
// toggle sitting right beside it, so the two read as the same button.
export function ChatListToggle({ collapsed, onToggle, className }: {
    collapsed: boolean
    onToggle: () => void
    className?: string
}) {
    // No list column while the chat list lives in the main sidebar.
    if (!FEATURE_FLAGS.employees) return null
    if (collapsed) {
        return (
            <Button
                variant="ghost"
                onClick={onToggle}
                title={`Show ${WORK_ITEM.plural.toLowerCase()}`}
                className={cn("h-8 px-3 gap-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors", className)}
            >
                <ListTodo className="h-4 w-4" />
                {WORK_ITEM.plural}
            </Button>
        )
    }
    return (
        <Button
            variant="ghost" size="icon"
            onClick={onToggle}
            title={`Hide ${WORK_ITEM.plural.toLowerCase()}`}
            className={cn("h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors", className)}
        >
            <PanelLeftClose className="h-4 w-4" />
        </Button>
    )
}

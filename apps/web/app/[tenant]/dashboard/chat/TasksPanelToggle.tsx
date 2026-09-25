"use client"

import { ListTodo, PanelLeftClose } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Opens/closes the Tasks panel. Closed, it says "Tasks" with its own icon:
// the bare panel icon it used to show was identical to the main sidebar's
// toggle sitting right beside it, so the two read as the same button.
export function TasksPanelToggle({ collapsed, onToggle, className }: {
    collapsed: boolean
    onToggle: () => void
    className?: string
}) {
    if (collapsed) {
        return (
            <Button
                variant="ghost"
                onClick={onToggle}
                title="Show tasks"
                className={cn("h-8 px-3 gap-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors", className)}
            >
                <ListTodo className="h-4 w-4" />
                Tasks
            </Button>
        )
    }
    return (
        <Button
            variant="ghost" size="icon"
            onClick={onToggle}
            title="Hide tasks"
            className={cn("h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors", className)}
        >
            <PanelLeftClose className="h-4 w-4" />
        </Button>
    )
}

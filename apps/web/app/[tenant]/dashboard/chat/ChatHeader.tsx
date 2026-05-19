'use client';
import { Bot, Info, MoreVertical, PanelRight, PanelLeftClose, PanelLeftOpen, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
    DropdownMenu, DropdownMenuContent,
    DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Conversation } from '@/components/platform/chat/types';

interface Props {
    selectedConversation: Conversation;
    isChatSidebarCollapsed: boolean;
    toggleChatSidebar: () => void;
    isCanvasOpen: boolean;
    hasActivity: boolean;
    toggleCanvas: () => void;
    onArchive: () => void;
}

export function ChatHeader({ selectedConversation, isChatSidebarCollapsed, toggleChatSidebar, isCanvasOpen, hasActivity, toggleCanvas, onArchive }: Props) {
    const title = selectedConversation.title
        || (selectedConversation.agent?.name ? `Chat with ${selectedConversation.agent.name}` : 'Chat with Agent');

    return (
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background shadow-sm z-10 shrink-0">
            <div className="flex items-center gap-3">
                <Button
                    variant="ghost" size="icon"
                    onClick={toggleChatSidebar}
                    className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground transition-all hover:bg-muted"
                >
                    {isChatSidebarCollapsed
                        ? <PanelLeftOpen className="h-4 w-4" />
                        : <PanelLeftClose className="h-4 w-4" />}
                </Button>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted border border-border/50">
                    <Bot className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                    <div className="flex items-center gap-2">
                        <h2 className="font-bold text-base tracking-tight truncate max-w-[200px] sm:max-w-[400px]">
                            {title}
                        </h2>
                        <Badge variant={selectedConversation.status === 'active' ? 'default' : 'secondary'} className="text-[10px] font-bold uppercase py-0 px-1.5 h-4.5 bg-primary/5 text-primary border-primary/20">
                            {selectedConversation.status ?? 'unknown'}
                        </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground font-medium">
                        Agent: {selectedConversation.agent?.name || 'Ready'}
                        {selectedConversation.agent?.type ? ` (${selectedConversation.agent.type})` : ''}
                    </p>
                </div>
            </div>
            <div className="flex items-center gap-2">
                <Button
                    variant={isCanvasOpen ? 'default' : 'outline'}
                    size="sm"
                    onClick={toggleCanvas}
                    className="relative flex"
                >
                    <PanelRight className="h-4 w-4 mr-2" />
                    Canvas
                    {hasActivity && !isCanvasOpen && (
                        <span className="absolute -top-1 -right-1 h-3 w-3 bg-green-500 rounded-full animate-pulse" />
                    )}
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
                    <Info className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem
                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                            onClick={onArchive}
                        >
                            <Archive className="h-4 w-4 mr-2" />
                            Archive Conversation
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    );
}

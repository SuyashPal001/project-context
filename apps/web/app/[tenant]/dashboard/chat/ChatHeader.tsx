'use client';
import { Info, MoreVertical, PanelRight, PanelLeftClose, PanelLeftOpen, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
    DropdownMenu, DropdownMenuContent,
    DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Conversation } from '@/components/platform/chat/types';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { PersonaAvatar } from '@/components/platform/personas/PersonaAvatar';
import { getAgentTypeIcon } from '@/components/platform/agents/agentTypeIcon';
import type { PersonaAnimationState } from '@/components/platform/personas/usePersonaAnimationState';

interface Props {
    selectedConversation: Conversation;
    isChatSidebarCollapsed: boolean;
    toggleChatSidebar: () => void;
    isCanvasOpen: boolean;
    hasActivity: boolean;
    toggleCanvas: () => void;
    onArchive: () => void;
    state: PersonaAnimationState;
}

export function ChatHeader({ selectedConversation, isChatSidebarCollapsed, toggleChatSidebar, isCanvasOpen, hasActivity, toggleCanvas, onArchive, state }: Props) {
    const title = selectedConversation.title
        || (selectedConversation.agent?.name ? `Chat with ${selectedConversation.agent.name}` : 'Chat with Agent');

    return (
        <div className="flex items-center justify-between px-6 py-4 bg-background z-10 shrink-0">
            <div className="flex items-center gap-3">
                <Button
                    variant="ghost" size="icon"
                    onClick={toggleChatSidebar}
                    className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                    {isChatSidebarCollapsed
                        ? <PanelLeftOpen className="h-4 w-4" />
                        : <PanelLeftClose className="h-4 w-4" />}
                </Button>
                <PersonaAvatar persona={selectedConversation.agent?.persona} state={state} size={36} className="rounded-full" icon={getAgentTypeIcon(selectedConversation.agent?.type)} />
                <div>
                    <div className="flex items-center gap-2">
                        <h2 className="font-semibold text-base tracking-tight truncate max-w-[200px] sm:max-w-[400px]">
                            {title}
                        </h2>
                        {selectedConversation.status !== 'active' && (
                            <Badge variant="secondary" className="text-[10px] font-bold uppercase py-0 px-1.5 h-4.5">
                                {selectedConversation.status}
                            </Badge>
                        )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70 font-medium">
                        Agent: {selectedConversation.agent?.name || 'Ready'}
                        {selectedConversation.agent?.type ? ` (${selectedConversation.agent.type})` : ''}
                    </p>
                </div>
            </div>
            <div className="flex items-center gap-2">
                {FEATURE_FLAGS.chatCanvas && (
                    <button
                        onClick={toggleCanvas}
                        className={cn(
                            "relative h-8 px-3 flex items-center gap-1.5 rounded-full border text-xs font-medium transition-colors",
                            isCanvasOpen
                                ? "border-primary/30 bg-primary/10 text-primary"
                                : "border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                    >
                        <PanelRight className="h-3.5 w-3.5" />
                        Canvas
                        {hasActivity && !isCanvasOpen && (
                            <span className="absolute -top-1 -right-1 h-2.5 w-2.5 bg-green-500 rounded-full animate-pulse" />
                        )}
                    </button>
                )}
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50">
                    <Info className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50">
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

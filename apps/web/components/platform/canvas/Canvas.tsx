'use client';

import { useState, useCallback, useEffect } from 'react';
import { CanvasViewer } from './CanvasViewer';
import { KnowledgeBaseSection } from './KnowledgeBaseSection';
import { ArtifactPanel } from './ArtifactPanel';
import { FileCreatedCard } from './FileCreatedCard';
import { api } from '@/lib/api';
import type {
  CanvasState, CanvasEvent, CanvasOverlay, CanvasEventData,
  CanvasAction, ArtifactState,
} from './types';

interface CanvasProps {
  isOpen: boolean;
  isExpanded?: boolean;
  onActivity?: () => void;
  onExpand?: () => void;
  tenantSlug: string;
  flushPending: () => void;
  agentId?: string;
}

const initialState: CanvasState = {
  currentScreenshot: null,
  currentUrl: null,
  actionHistory: [],
  isActive: false,
  overlays: [],
};

const OVERLAY_DURATION = 2000;

export function Canvas({ isOpen, isExpanded, onActivity, onExpand, tenantSlug, flushPending, agentId }: CanvasProps) {
  const [state, setState] = useState<CanvasState>(initialState);
  const [recentFiles, setRecentFiles] = useState<Array<{ path: string; type?: string }>>([]);
  const [artifact, setArtifact] = useState<ArtifactState | null>(null);
  const [activeTab, setActiveTab] = useState<'artifact' | 'knowledge'>('artifact');

  // Restore latest PRD from DB when agentId changes (e.g. page refresh or conversation switch)
  useEffect(() => {
    if (!agentId) return;
    api.get<{ data: Array<{ id: string; title: string; content: string; status: string; version: number }> }>(
      `/api/v1/prds?agentId=${agentId}`
    ).then(res => {
      const prd = res.data?.[0];
      if (!prd) return;
      setArtifact({
        type: 'prd',
        title: prd.title,
        content: prd.content,
        isStreaming: false,
        entityId: prd.id,
        entityMeta: { version: prd.version },
        approveStatus: prd.status === 'approved' ? 'done' : 'idle',
      });
      setActiveTab('artifact');
      // Open the canvas panel so the restored artifact is visible
      (window as any).__openCanvas?.();
    }).catch(() => {});
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up expired overlays
  useEffect(() => {
    const interval = setInterval(() => {
      setState(prev => ({
        ...prev,
        overlays: prev.overlays.filter(o => o.expiresAt > Date.now()),
      }));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const handleCanvasUpdate = useCallback((action: CanvasAction, data: CanvasEventData) => {
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const event: CanvasEvent = { id: eventId, action, timestamp, data };

    // Handle artifact streaming actions first
    if (action === 'artifact_start') {
      console.log('[canvas] artifact_start received:', data);
      setArtifact({
        type: data.artifactType!,
        title: data.artifactTitle!,
        content: '',
        isStreaming: true,
        entityId: null,
        entityMeta: null,
        approveStatus: 'idle',
      });
      setActiveTab('artifact');
      onActivity?.();
      return;
    }

    if (action === 'artifact_chunk') {
      setArtifact(prev => prev ? { ...prev, content: prev.content + (data.chunk ?? '') } : prev);
      onActivity?.();
      return;
    }

    if (action === 'artifact_done') {
      setArtifact(prev => prev ? {
        ...prev,
        isStreaming: false,
        entityId: data.entityId ?? null,
        entityMeta: data.entityMeta ?? null,
      } : prev);
      onActivity?.();
      return;
    }

    if (action === 'artifact_load') {
      const { artifactType, artifactTitle, entityId, chunk: content } = data;
      const type = artifactType!;
      const title = String(artifactTitle ?? type?.toUpperCase() ?? '');
      if (content) {
        setArtifact({ type, title, content: String(content), isStreaming: false, entityId: entityId ?? null, entityMeta: null, approveStatus: 'idle' });
      } else if (type === 'prd' && entityId) {
        api.get<{ data: { content: string } }>(`/api/v1/prds/${entityId}`)
          .then(res => { const c = res.data?.content; if (c) setArtifact({ type, title, content: c, isStreaming: false, entityId: entityId ?? null, entityMeta: null, approveStatus: 'idle' }); })
          .catch(() => {});
      } else {
        setArtifact({ type, title, content: '', isStreaming: false, entityId: entityId ?? null, entityMeta: null, approveStatus: 'idle' });
      }
      setActiveTab('artifact');
      onActivity?.();
      return;
    }

    // Browser / file_created actions update canvas state
    if (action === 'file_created') {
      if (data.filePath) {
        setRecentFiles(prev => [{ path: data.filePath!, type: data.fileType }, ...prev.slice(0, 4)]);
      }
      onActivity?.();
      return;
    }

    setState(prev => {
      const newState: CanvasState = {
        ...prev,
        isActive: true,
        actionHistory: [...prev.actionHistory, event].slice(-50),
      };
      switch (action) {
        case 'screenshot':
          if (data.screenshot) newState.currentScreenshot = data.screenshot;
          if (data.url) newState.currentUrl = data.url;
          break;
        case 'navigate':
          if (data.url) newState.currentUrl = data.url;
          break;
        case 'click':
          if (data.x !== undefined && data.y !== undefined) {
            const overlay: CanvasOverlay = {
              id: eventId, type: 'click', x: data.x, y: data.y,
              expiresAt: Date.now() + OVERLAY_DURATION,
            };
            newState.overlays = [...prev.overlays, overlay];
          }
          break;
        case 'type':
          if (data.x !== undefined && data.y !== undefined) {
            const overlay: CanvasOverlay = {
              id: eventId, type: 'type', x: data.x, y: data.y, text: data.text,
              expiresAt: Date.now() + OVERLAY_DURATION,
            };
            newState.overlays = [...prev.overlays, overlay];
          }
          break;
      }
      return newState;
    });

    onActivity?.();
  }, [onActivity]);

  const handleReset = useCallback(() => {
    setState(initialState);
    setRecentFiles([]);
    setArtifact(null);
    setActiveTab('knowledge');
  }, []);

  useEffect(() => {
    (window as any).__canvasUpdate = handleCanvasUpdate;
    (window as any).__canvasReset = handleReset;
    flushPending();
    return () => {
      delete (window as any).__canvasUpdate;
      delete (window as any).__canvasReset;
    };
  }, [handleCanvasUpdate, handleReset, flushPending]);

  const handleApprove = useCallback(async () => {
    if (!artifact) return;
    setArtifact(prev => prev ? { ...prev, approveStatus: 'loading' } : prev);
    try {
      if (artifact.type === 'prd' && artifact.entityId) {
        await api.patch(`/api/v1/prds/${artifact.entityId}/approve`, {});
      } else if (artifact.type === 'roadmap' && artifact.entityId) {
        await api.patch(`/api/v1/plans/${artifact.entityId}/approve`, {});
      }
      // tasks: no API call needed — just mark done
      setArtifact(prev => prev ? { ...prev, approveStatus: 'done' } : prev);
    } catch {
      setArtifact(prev => prev ? { ...prev, approveStatus: 'error' } : prev);
    }
  }, [artifact]);

  if (!isOpen) return null;

  return (
    <div className="flex flex-col h-full bg-background border-l border-border">
      {/* Header */}
      <div className="flex-none flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-sm">Agent Canvas</h3>
        {state.isActive && (
          <span className="flex items-center gap-1.5 text-xs text-green-500">
            <span className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
            Live
          </span>
        )}
      </div>

      {/* Tab bar — always visible */}
      <div className="flex-none flex border-b border-border">
        <button
          className={`flex-1 px-4 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === 'artifact'
              ? 'text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('artifact')}
        >
          Artifact
          {artifact?.isStreaming && (
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          )}
        </button>
        <button
          className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === 'knowledge'
              ? 'text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('knowledge')}
        >
          Knowledge Base
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {/* Browser Viewer (hidden until browser automation is active) */}
        <div className="hidden flex-none p-4 pb-3">
          <CanvasViewer
            screenshot={state.currentScreenshot}
            url={state.currentUrl}
            overlays={state.overlays}
            isActive={state.isActive}
            isFullscreen={isExpanded}
            onFullscreen={onExpand}
          />
        </div>

        {/* Recent Files */}
        {recentFiles.length > 0 && (activeTab === 'knowledge' || !artifact) && (
          <div className="flex-none px-4 pb-3 space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-px flex-1 bg-border/50" />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">Created Files</span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
            {recentFiles.map((file, i) => (
              <FileCreatedCard key={`${file.path}-${i}`} filePath={file.path} fileType={file.type} />
            ))}
          </div>
        )}

        {/* Tab content */}
        {activeTab === 'artifact' ? (
          artifact ? (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <ArtifactPanel
                artifact={artifact}
                onApprove={handleApprove}
                onContentLoaded={(content) => setArtifact(prev => prev ? { ...prev, content } : prev)}
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-sm text-muted-foreground">No artifact yet.</p>
              <p className="text-xs text-muted-foreground/60">Ask the agent to create a PRD, roadmap, or task list.</p>
            </div>
          )
        ) : (
          <KnowledgeBaseSection />
        )}
      </div>
    </div>
  );
}

export type CanvasUpdateHandler = (action: CanvasAction, data: CanvasEventData) => void;

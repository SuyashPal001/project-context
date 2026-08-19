'use client';

import { useState, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CanvasViewer } from './CanvasViewer';
import { KnowledgeBaseSection } from './KnowledgeBaseSection';
import { ArtifactPanel } from './ArtifactPanel';
import { FileCreatedCard } from './FileCreatedCard';
import { AssetGallery } from './AssetGallery';
import { AssetLightbox } from './AssetLightbox';
import { CanvasTabStrip } from './CanvasTabStrip';
import { api } from '@/lib/api';
import type {
  CanvasState, CanvasEvent, CanvasOverlay, CanvasEventData,
  CanvasAction, ArtifactState, ArtifactType, CanvasTab,
} from './types';
import type { Asset } from '@/types/assets';

interface CanvasProps {
  isOpen: boolean;
  isExpanded?: boolean;
  onActivity?: () => void;
  onExpand?: () => void;
  tenantSlug: string;
  flushPending: () => void;
  agentId?: string;
  conversationId: string;
}

const initialState: CanvasState = {
  currentScreenshot: null,
  currentUrl: null,
  actionHistory: [],
  isActive: false,
  overlays: [],
};

const OVERLAY_DURATION = 2000;

export function Canvas({ isOpen, isExpanded, onActivity, onExpand, tenantSlug, flushPending, agentId, conversationId }: CanvasProps) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CanvasState>(initialState);
  const [recentFiles, setRecentFiles] = useState<Array<{ path: string; type?: string }>>([]);
  const KNOWLEDGE_TAB: CanvasTab = { id: 'knowledge', kind: 'knowledge', title: 'Knowledge Base', closeable: false };
  const ARTIFACT_TAB_ID = 'artifact';

  const [tabs, setTabs] = useState<CanvasTab[]>([KNOWLEDGE_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('knowledge');
  const [lightboxAsset, setLightboxAsset] = useState<{ asset: Asset; allAssets: Asset[] } | null>(null);

  const upsertArtifactTab = useCallback((updater: (prev: ArtifactState | null) => ArtifactState | null, focus: boolean) => {
    setTabs(prev => {
      const existing = prev.find(t => t.id === ARTIFACT_TAB_ID);
      const nextArtifact = updater(existing?.artifact ?? null);
      if (!nextArtifact) return prev;
      if (existing) {
        return prev.map(t => t.id === ARTIFACT_TAB_ID ? { ...t, title: nextArtifact.title, artifact: nextArtifact } : t);
      }
      return [...prev, { id: ARTIFACT_TAB_ID, kind: 'artifact', title: nextArtifact.title, closeable: true, artifact: nextArtifact }];
    });
    if (focus) setActiveTabId(ARTIFACT_TAB_ID);
  }, []);

  const openAssetTab = useCallback((asset: Asset) => {
    const tabId = `file-${asset.id}`;
    setTabs(prev => prev.some(t => t.id === tabId)
      ? prev
      : [...prev, { id: tabId, kind: 'file', title: asset.filename, closeable: true, asset }]);
    setActiveTabId(tabId);
  }, []);

  const openGalleryTab = useCallback(() => {
    const tabId = 'gallery';
    setTabs(prev => prev.some(t => t.id === tabId)
      ? prev
      : [...prev, { id: tabId, kind: 'gallery', title: 'Chat History', closeable: true }]);
    setActiveTabId(tabId);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      setActiveTabId(current => {
        if (current !== tabId) return current;
        return next[next.length - 1]?.id ?? 'knowledge';
      });
      return next;
    });
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? KNOWLEDGE_TAB;

  // Restore latest PRD from DB when agentId changes (e.g. page refresh or conversation switch)
  useEffect(() => {
    if (!agentId) return;
    api.get<{ data: Array<{ id: string; title: string; content: string; status: string; version: number }> }>(
      `/api/v1/prds?agentId=${agentId}`
    ).then(res => {
      const prd = res.data?.[0];
      if (!prd) return;
      // Only steal focus if the tab list is still at its initial state — a user who has
      // already opened other tabs should not be yanked back to the restored artifact.
      const isInitial = activeTabId === 'knowledge' && tabs.length === 1;
      upsertArtifactTab(() => ({
        type: 'prd',
        title: prd.title,
        content: prd.content,
        isStreaming: false,
        entityId: prd.id,
        entityMeta: { version: prd.version },
        approveStatus: prd.status === 'approved' ? 'done' : 'idle',
      }), isInitial);
      // Do NOT auto-open — user opens canvas explicitly via the button.
      // Auto-opening on agentId change fires on every conversation switch,
      // including fresh conversations, which is jarring.
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
      upsertArtifactTab(() => ({
        type: data.artifactType!,
        title: data.artifactTitle!,
        content: '',
        isStreaming: true,
        entityId: null,
        entityMeta: null,
        approveStatus: 'idle',
      }), true);
      onActivity?.();
      return;
    }

    if (action === 'artifact_chunk') {
      upsertArtifactTab(prev => prev ? { ...prev, content: prev.content + (data.chunk ?? '') } : prev, false);
      onActivity?.();
      return;
    }

    if (action === 'artifact_done') {
      const meta = data.entityMeta ?? null;
      upsertArtifactTab(prev => prev ? {
        ...prev,
        isStreaming: false,
        entityId: data.entityId ?? prev.entityId,
        entityMeta: meta,
        pmRunId: (meta as any)?.pmRunId ?? prev.pmRunId,
        pmStepId: (meta as any)?.pmStepId ?? prev.pmStepId,
      } : prev, false);
      queryClient.invalidateQueries({ queryKey: ['conversation-assets', conversationId] });
      onActivity?.();
      return;
    }

    if (action === 'artifact_load') {
      const { artifactType, artifactTitle, entityId, chunk: content, entityMeta } = data;
      const type = artifactType!;
      const title = String(artifactTitle ?? type?.toUpperCase() ?? '');
      const pmRunId = (entityMeta as any)?.pmRunId as string | undefined;
      const pmStepId = (entityMeta as any)?.pmStepId as string | undefined;
      const base = { type, title, isStreaming: false, entityId: entityId ?? null, entityMeta: entityMeta ?? null, approveStatus: 'idle' as const, pmRunId, pmStepId };
      if (content) {
        upsertArtifactTab(() => ({ ...base, content: String(content) }), true);
      } else if (type === 'prd' && entityId) {
        api.get<{ data: { content: string } }>(`/api/v1/prds/${entityId}`)
          .then(res => { const c = res.data?.content; if (c) upsertArtifactTab(() => ({ ...base, content: c }), true); })
          .catch(() => {});
      } else {
        upsertArtifactTab(() => ({ ...base, content: '' }), true);
      }
      onActivity?.();
      return;
    }

    if (action === 'asset_open') {
      if (data.asset) openAssetTab(data.asset);
      onActivity?.();
      return;
    }

    // Browser / file_created actions update canvas state
    if (action === 'file_created') {
      if (data.filePath) {
        setRecentFiles(prev => [{ path: data.filePath!, type: data.fileType }, ...prev.slice(0, 4)]);
      }
      queryClient.invalidateQueries({ queryKey: ['conversation-assets', conversationId] });
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
  }, [onActivity, queryClient, conversationId]);

  const handleReset = useCallback(() => {
    setState(initialState);
    setRecentFiles([]);
    setTabs([KNOWLEDGE_TAB]);
    setActiveTabId('knowledge');
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

  const handleRevise = useCallback(async (instructions: string) => {
    const artifact = activeTab.artifact;
    if (!artifact?.pmRunId || !artifact?.pmStepId) return;
    upsertArtifactTab(prev => prev ? { ...prev, approveStatus: 'loading' } : prev, false);
    try {
      const relayBase = (process.env.NEXT_PUBLIC_AGENT_WS_URL ?? 'wss://agent-orchestrator.projectcontext.co')
        .replace(/^wss?:\/\//, 'https://');
      const cookies = document.cookie.split('; ');
      const accessToken = cookies.find(r => r.startsWith('platform_access_token='))?.split('=')[1] ?? '';
      const res = await fetch(`${relayBase}/pm/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ runId: artifact.pmRunId, stepId: artifact.pmStepId, revise: instructions }),
      });
      if (!res.ok) throw new Error(`pm/resume ${res.status}`);
      const data = await res.json() as { phase: string; prdId?: string; title?: string; runId?: string; stepId?: string };
      if (data.phase === 'prd' && data.prdId) {
        // Fetch the revised content and update the canvas
        const prdRes = await api.get<{ data: { content: string } }>(`/api/v1/prds/${data.prdId}`);
        const content = prdRes.data?.content ?? '';
        upsertArtifactTab(prev => prev ? {
          ...prev,
          title: data.title ?? prev.title,
          content,
          approveStatus: 'idle',
          pmRunId: data.runId,
          pmStepId: data.stepId,
        } : prev, false);
      }
    } catch {
      upsertArtifactTab(prev => prev ? { ...prev, approveStatus: 'error' } : prev, false);
    }
  }, [activeTab, upsertArtifactTab]);

  const handleApprove = useCallback(async () => {
    const artifact = activeTab.artifact;
    if (!artifact) return;
    upsertArtifactTab(prev => prev ? { ...prev, approveStatus: 'loading' } : prev, false);
    try {
      // Mastra HITL path: resume the pm-workflow suspension
      if (artifact.pmRunId && artifact.pmStepId) {
        const relayBase = (process.env.NEXT_PUBLIC_AGENT_WS_URL ?? 'wss://agent-orchestrator.projectcontext.co')
          .replace(/^wss?:\/\//, 'https://');
        const cookies = document.cookie.split('; ');
        const accessToken = cookies.find(r => r.startsWith('platform_access_token='))?.split('=')[1] ?? '';
        const isConfirm = artifact.type === 'tasks';
        const body: Record<string, unknown> = {
          runId: artifact.pmRunId,
          stepId: artifact.pmStepId,
          ...(isConfirm ? { confirmed: true } : { approved: true }),
        };
        const res = await fetch(`${relayBase}/pm/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`pm/resume ${res.status}`);
        const data = await res.json() as {
          phase: string; runId?: string; stepId?: string;
          planId?: string; title?: string; taskCount?: number;
        };
        if (data.phase === 'done') {
          upsertArtifactTab(prev => prev ? { ...prev, approveStatus: 'done', pmRunId: undefined, pmStepId: undefined } : prev, false);
          return;
        }
        // Move to next artifact (roadmap or tasks)
        const nextType = data.phase === 'roadmap' ? 'roadmap' : 'tasks';
        const nextTitle = data.title ?? nextType.toUpperCase();
        const nextEntityId = data.planId ?? null;
        upsertArtifactTab(() => ({
          type: nextType as ArtifactType,
          title: nextTitle,
          content: '',
          isStreaming: false,
          entityId: nextEntityId,
          entityMeta: data.taskCount != null ? { taskCount: data.taskCount } : null,
          approveStatus: 'idle',
          pmRunId: data.runId,
          pmStepId: data.stepId,
        }), true);
        // Open canvas so new artifact is visible
        (window as any).__openCanvas?.();
        return;
      }
      // Legacy fallback: direct PATCH (no HITL workflow)
      if (artifact.type === 'prd' && artifact.entityId) {
        await api.patch(`/api/v1/prds/${artifact.entityId}/approve`, {});
      } else if (artifact.type === 'roadmap' && artifact.entityId) {
        await api.patch(`/api/v1/plans/${artifact.entityId}/approve`, {});
      }
      upsertArtifactTab(prev => prev ? { ...prev, approveStatus: 'done' } : prev, false);
    } catch {
      upsertArtifactTab(prev => prev ? { ...prev, approveStatus: 'error' } : prev, false);
    }
  }, [activeTab, upsertArtifactTab]);

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
      <CanvasTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={closeTab}
        onOpenGallery={openGalleryTab}
      />

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
        {recentFiles.length > 0 && activeTab.kind === 'knowledge' && (
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

        {activeTab.kind === 'artifact' && activeTab.artifact && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <ArtifactPanel
              artifact={activeTab.artifact}
              onApprove={handleApprove}
              onRevise={handleRevise}
              onContentLoaded={(content) => upsertArtifactTab(prev => prev ? { ...prev, content } : prev, false)}
              tenantSlug={tenantSlug}
            />
          </div>
        )}

        {activeTab.kind === 'knowledge' && <KnowledgeBaseSection />}

        {activeTab.kind === 'gallery' && (
          <AssetGallery conversationId={conversationId ?? ''} onCardClick={(asset, allAssets) => setLightboxAsset({ asset, allAssets })} />
        )}

        {activeTab.kind === 'file' && activeTab.asset && (
          <AssetGallery conversationId={conversationId ?? ''} filterAssetId={activeTab.asset.id} fallbackAsset={activeTab.asset} onCardClick={(asset, allAssets) => setLightboxAsset({ asset, allAssets })} />
        )}
      </div>
      {lightboxAsset && (
        <AssetLightbox
          asset={lightboxAsset.asset}
          allAssets={lightboxAsset.allAssets}
          onClose={() => setLightboxAsset(null)}
          onNavigate={(asset) => setLightboxAsset(prev => prev ? { asset, allAssets: prev.allAssets } : prev)}
        />
      )}
    </div>
  );
}

export type CanvasUpdateHandler = (action: CanvasAction, data: CanvasEventData) => void;

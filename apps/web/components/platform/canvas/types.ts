/**
 * Canvas Types
 */

export type ArtifactType = 'prd' | 'roadmap' | 'tasks' | 'document'

export interface ArtifactState {
  type: ArtifactType
  title: string
  content: string
  isStreaming: boolean
  entityId: string | null
  entityMeta: Record<string, unknown> | null
  approveStatus: 'idle' | 'loading' | 'done' | 'error'
  // Mastra HITL: approval-gate resumption data (from message artifactRef)
  pmRunId?: string
  pmStepId?: string
}

export type CanvasAction =
  | 'screenshot'
  | 'click'
  | 'type'
  | 'navigate'
  | 'scroll'
  | 'file_created'
  | 'artifact_start'
  | 'artifact_chunk'
  | 'artifact_done'
  | 'artifact_load'
  | 'asset_open'

export interface CanvasEvent {
  id: string;
  action: CanvasAction;
  timestamp: string;
  data: CanvasEventData;
}

export interface CanvasEventData {
  screenshot?: string;
  url?: string;
  elementSelector?: string;
  text?: string;
  filePath?: string;
  fileType?: string;
  x?: number;
  y?: number;
  scrollTop?: number;
  // Artifact streaming
  artifactType?: ArtifactType;
  artifactTitle?: string;
  chunk?: string;
  entityId?: string;
  entityMeta?: Record<string, unknown>;
  // Asset open bridge
  asset?: import('@/types/assets').Asset;
  [key: string]: unknown;
}

export interface CanvasState {
  currentScreenshot: string | null;
  currentUrl: string | null;
  actionHistory: CanvasEvent[];
  isActive: boolean;
  overlays: CanvasOverlay[];
}

export interface CanvasOverlay {
  id: string;
  type: 'click' | 'type' | 'scroll';
  x?: number;
  y?: number;
  text?: string;
  expiresAt: number;
}

export type CanvasTabKind = 'artifact' | 'knowledge' | 'file' | 'gallery';

export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  title: string;
  closeable: boolean;
  /** Present only for kind: 'artifact' */
  artifact?: ArtifactState;
  /** Present only for kind: 'file' */
  asset?: import('@/types/assets').Asset;
}

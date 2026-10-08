'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ToolCallSearchResult, MessageAttachment } from './types';
import { TYPE_STYLES, TYPE_BADGES } from '@/components/platform/canvas/assetTypeStyles';
import { PixelLoader, useElapsedLabel } from './PixelLoader';
import { InlineAttachmentCard } from './InlineAttachmentCard';

// True while a generation approval card is waiting on the user. The delegate's
// "Generating visual…" skeleton would otherwise sit there as if work were under
// way, when nothing has been approved (or spent) yet.
export const AwaitingApprovalContext = createContext(false);

interface ToolCallCardProps {
  toolName: string;
  query: string;
  /** Delegate calls only: Olmo's full instruction to the specialist. Used to
   *  tell a narration or video hand-off from an image one; never displayed. */
  prompt?: string;
  status: 'loading' | 'done';
  results?: ToolCallSearchResult[];
  result?: Record<string, unknown>;
  /** Delegate calls only: true once the generation itself has begun. */
  generationStarted?: boolean;
  /** "9:16", "1:1", ... — shapes the generating skeleton like the result. 16:9 when unknown. */
  aspectRatio?: string;
  /** Live per-item progress for a batch generation call (generate_images/generate_videos). */
  batchProgress?: { done: number; total: number };
  /** Item count for a batch call, known from generation_started before any item has
   *  settled — lets the skeleton render N tiles immediately instead of just one. */
  mediaCount?: number;
  /** fileId -> presigned URL, same map MessageItem passes for message.attachments
   *  (see MessageThread's refreshUrls effect, extended to also scan tool results).
   *  Lets a completed generation/show_files call render its image inline right
   *  away, instead of only once the whole turn finishes and attachments land. */
  freshUrls?: Record<string, string>;
  /** Live status line from a tool_status event — replaces the generic "Preparing…" while set. */
  statusText?: string;
  /** Sub-lines under the status, e.g. one per person being cast. */
  statusDetails?: string[];
  /** Director calls only: the kind of media its running step is making now
   *  (from the live step list), so the row follows the work: stills first,
   *  then clips, then the voice. */
  liveKind?: 'image' | 'video' | 'audio';
}

// The web must re-show generated media the moment a tool call completes — not
// only once the whole turn finishes (message.attachments), because a turn can
// suspend on ask_clarifying_questions right after several image rows complete,
// and attachments never land while the turn is suspended. Called for any
// media-gen tool result (single {fileId,...} or batch {results:[...]}) and for
// show_files's own {files:[...]} shape, so both render through this one path.
export function extractResultFiles(
  toolName: string,
  result: Record<string, unknown> | undefined,
): Array<{ fileId: string; name: string; fileType: string; size?: number }> {
  if (!result) return [];
  // A delegate's own generate_image/show_files calls never reach the browser as
  // separate tool calls: their results ride inside the delegate's result as
  // subAgentToolResults. Without reading them here, a storyboard the Director
  // made and showed stayed invisible until the turn ended, and a turn that
  // stops on a question never ends (2026-10-05 animated ad: "where is story
  // board i dont see any of it").
  if (isDirectorDelegateTool(toolName) || isProducerDelegateTool(toolName)) {
    const inner = Array.isArray(result.subAgentToolResults) ? result.subAgentToolResults as Array<Record<string, unknown>> : [];
    const byId = new Map<string, { fileId: string; name: string; fileType: string; size?: number }>();
    for (const entry of inner) {
      if (typeof entry.toolName !== 'string' || !entry.result || typeof entry.result !== 'object') continue;
      for (const f of extractResultFiles(entry.toolName, entry.result as Record<string, unknown>)) if (!byId.has(f.fileId)) byId.set(f.fileId, f);
    }
    return [...byId.values()];
  }
  // Narration is read here but stays out of isMediaGenTool: its file hangs
  // under the Voice step, and it has no generating card of its own (2026-10-09).
  const isNarration = toolName === 'generate_narration' || toolName === 'generate-narration';
  if (!isMediaGenTool(toolName) && !isNarration && toolName !== 'show_files') return [];

  const toEntry = (entry: Record<string, unknown>): { fileId: string; name: string; fileType: string; size?: number } | null => {
    if (typeof entry.fileId !== 'string') return null;
    return {
      fileId: entry.fileId,
      name: typeof entry.name === 'string' ? entry.name : '',
      fileType: typeof entry.fileType === 'string' ? entry.fileType : (typeof entry.type === 'string' ? entry.type : ''),
      size: typeof entry.size === 'number' ? entry.size : undefined,
    };
  };

  if (Array.isArray(result.results)) {
    return (result.results as Array<Record<string, unknown>>).map(toEntry).filter((e): e is NonNullable<typeof e> => e !== null);
  }
  if (Array.isArray(result.files)) {
    return (result.files as Array<Record<string, unknown>>).map(toEntry).filter((e): e is NonNullable<typeof e> => e !== null);
  }
  const single = toEntry(result);
  return single ? [single] : [];
}

// Director's tools are registered under the underscore key (generate_image,
// edit_image) — that's the raw toolName this component receives (unnormalized,
// unlike chatStream.ts's server-side gate). Matched loosely so a hyphenated
// form works too if a future caller normalizes before this point.
function isImageGenTool(toolName: string): boolean {
  return toolName === 'generate_image' || toolName === 'generate-image'
    || toolName === 'edit_image' || toolName === 'edit-image'
    || toolName === 'generate_images' || toolName === 'generate-images';
}

// Producer's tool follows the same unnormalized-key convention as Director's
// (registered as 'generate_song' in producerAgent.ts).
function isSongGenTool(toolName: string): boolean {
  return toolName === 'generate_song' || toolName === 'generate-song';
}

// Director's video tool follows the same unnormalized-key convention as its
// image tools (registered as 'generate_video' in directorAgent.ts).
function isVideoGenTool(toolName: string): boolean {
  return toolName === 'generate_video' || toolName === 'generate-video'
    || toolName === 'generate_videos' || toolName === 'generate-videos';
}

// Anything this card must treat as "may render a media artifact, not proof
// that one exists" — see the comment on mediaGenFailureReason below.
function isMediaGenTool(toolName: string): boolean {
  return isImageGenTool(toolName) || isSongGenTool(toolName) || isVideoGenTool(toolName);
}

// Olmo delegates to these subagents (registered as 'agent-<id>', see
// sources.ts) for a whole image/video/audio turn — their own
// generate_image/generate_video/generate_song calls never reach this card as
// separate tool-call events, so without this the delegate badge just shows
// bouncing dots with zero visual for however long the subagent's turn takes.
// Matching on the delegate name lets the same media skeleton stand in.
function isDirectorDelegateTool(toolName: string): boolean {
  return toolName === 'agent-director' || toolName === 'agent_director';
}
function isProducerDelegateTool(toolName: string): boolean {
  return toolName === 'agent-producer' || toolName === 'agent_producer';
}
/** The Director / Producer's own row: while step rows show, they already say what it is doing. */
export function isMediaDelegateTool(toolName: string): boolean {
  return isDirectorDelegateTool(toolName) || isProducerDelegateTool(toolName);
}
/** A tool that asks the user something; it belongs to the part of the turn that asked. */
export function isQuestionTool(toolName: string): boolean {
  return /^(ask_clarifying_questions|review_shots|request_upload)$/.test(toolName.replace(/-/g, '_'));
}
function isPmDelegateTool(toolName: string): boolean {
  return toolName === 'agent-pm' || toolName === 'agent_pm';
}
function isArchitectDelegateTool(toolName: string): boolean {
  return toolName === 'agent-architect' || toolName === 'agent_architect';
}

// generateImage.ts/editImage.ts/generateSong.ts/generateVideo.ts return
// `refused: true, refusalReason` (or `insufficientCredits: true`) on any
// failure, with no `fileId` — the model doesn't reliably relay that in its
// reply text, so this component must not take "a tool-result event arrived"
// as proof the artifact exists. Only a real fileId means one does. Producer's
// failure vocabulary is a subset of Director's image path — no SOURCE_IMAGE_*
// (it never uses a source image), and no SAFETY today. generateVideo.ts's own
// vocabulary is narrower still — only GENERATION_FAILED, STORAGE_FAILED, or a
// gateway passthrough `reason` string — no video-specific SAFETY-equivalent
// yet. The gateway can also pass through its own reason strings (e.g.
// NO_PREDICTIONS, NO_AUDIO_BYTES) that fall through to the generic message
// below.
export function mediaGenFailureReason(toolName: string, result: Record<string, unknown> | undefined): string | null {
  if (!result) return null;
  if (Array.isArray(result.results)) {
    const entries = result.results as Array<Record<string, unknown>>;
    if (entries.some((entry) => typeof entry.fileId === 'string')) return null;
    if (entries.length > 0 && entries.every((entry) => entry.insufficientCredits === true)) return 'Out of credits';
    return isVideoGenTool(toolName) ? 'Video generation failed' : 'Image generation failed';
  }
  if (typeof result.fileId === 'string') return null;
  // The orchestrator sends { failed: true } when the tool threw instead of returning.
  if (result.failed === true) return isVideoGenTool(toolName) ? 'Video generation failed' : isSongGenTool(toolName) ? 'Song generation failed' : 'Image generation failed';
  if (result.insufficientCredits) return 'Out of credits';
  const reason = typeof result.refusalReason === 'string' ? result.refusalReason : undefined;
  if (reason === 'STORAGE_FAILED') return 'Generated, but could not be saved';
  if (reason === 'SAFETY') return 'Declined for content policy reasons';
  if (reason === 'SOURCE_IMAGE_UNAVAILABLE' || reason === 'SOURCE_IMAGE_TOO_LARGE') return 'Source image unavailable';
  if (isVideoGenTool(toolName)) return 'Video generation failed';
  return isSongGenTool(toolName) ? 'Song generation failed' : 'Image generation failed';
}

// Olmo's own helper tools, each with its own wording and icon, so a trace
// reads as what happened ("Checked your credits") instead of a column of
// identical "Used <tool name>" rows behind the same key icon.
type HelperIcon = 'skill' | 'credits' | 'question' | 'people' | 'folder' | 'crop' | 'eye' | 'clock' | 'upload' | 'layers' | 'memory' | 'link';
const HELPER_TOOLS: Record<string, { loading: string; done: string; icon: HelperIcon }> = {
  skill: { loading: 'Loading skill', done: 'Loaded skill', icon: 'skill' },
  check_credit_plan: { loading: 'Checking your credits', done: 'Checked your credits', icon: 'credits' },
  ask_clarifying_questions: { loading: 'Preparing a few questions', done: 'Asked a few questions', icon: 'question' },
  review_shots: { loading: 'Asking how the scenes look', done: 'Checked the scenes with you', icon: 'question' },
  list_casting_assets: { loading: 'Browsing avatars', done: 'Browsed avatars', icon: 'people' },
  show_files: { loading: 'Bringing up your files', done: 'Showed your files', icon: 'folder' },
  list_folder: { loading: 'Looking in your Drive', done: 'Looked in your Drive', icon: 'folder' },
  find_in_folder: { loading: 'Searching your Drive', done: 'Searched your Drive', icon: 'folder' },
  read_file: { loading: 'Reading file', done: 'Read file', icon: 'folder' },
  crop_image: { loading: 'Cropping image', done: 'Cropped image', icon: 'crop' },
  analyze_image: { loading: 'Looking at the image', done: 'Looked at the image', icon: 'eye' },
  analyze_audio: { loading: 'Listening to the audio', done: 'Listened to the audio', icon: 'eye' },
  analyze_video: { loading: 'Watching the video', done: 'Watched the video', icon: 'eye' },
  find_past_tasks: { loading: 'Looking through past work', done: 'Looked through past work', icon: 'clock' },
  get_task_thread: { loading: 'Checking the task', done: 'Checked the task', icon: 'clock' },
  start_task: { loading: 'Starting a task', done: 'Started a task', icon: 'clock' },
  retrieve_template: { loading: 'Opening the template', done: 'Opened the template', icon: 'layers' },
  render_canvas: { loading: 'Laying out the canvas', done: 'Laid out the canvas', icon: 'layers' },
  request_upload: { loading: 'Asking for an upload', done: 'Asked for an upload', icon: 'upload' },
  draft_skill: { loading: 'Drafting a skill', done: 'Drafted a skill', icon: 'skill' },
  save_skill: { loading: 'Saving the skill', done: 'Saved the skill', icon: 'skill' },
  updateWorkingMemory: { loading: 'Updating memory', done: 'Updated memory', icon: 'memory' },
  web_fetch: { loading: 'Reading the page', done: 'Read the page', icon: 'link' },
};

/** "ugc-avatar-creator" -> "UGC avatar creator", for the skill row's highlight. */
export function skillDisplayName(slug: string): string {
  const words = slug.trim().replace(/[-_]+/g, ' ').replace(/\b(tvc|ugc)\b/gi, (w) => w.toUpperCase());
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

const iconProps = { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', className: 'opacity-60 shrink-0 text-current' } as const;

function HelperToolIcon({ icon }: { icon: HelperIcon }) {
  switch (icon) {
    case 'skill': return (
      <svg {...iconProps}><path d="M7 1.5l1.3 3.2 3.2 1.3-3.2 1.3L7 10.5 5.7 7.3 2.5 6l3.2-1.3z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/><path d="M11 9.5l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" fill="currentColor"/></svg>
    );
    case 'credits': return (
      <svg {...iconProps}><ellipse cx="7" cy="4" rx="4.5" ry="2" stroke="currentColor" strokeWidth="1"/><path d="M2.5 4v3c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4" stroke="currentColor" strokeWidth="1"/><path d="M2.5 7v3c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V7" stroke="currentColor" strokeWidth="1"/></svg>
    );
    case 'question': return (
      <svg {...iconProps}><path d="M2 3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2.5V10H3a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/><path d="M5.8 4.6a1.2 1.2 0 1 1 1.7 1.1c-.4.2-.5.5-.5.8" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round"/><circle cx="7" cy="8" r="0.5" fill="currentColor"/></svg>
    );
    case 'people': return (
      <svg {...iconProps}><circle cx="5" cy="5" r="2" stroke="currentColor" strokeWidth="1"/><path d="M1.5 12c0-2 1.6-3.5 3.5-3.5S8.5 10 8.5 12" stroke="currentColor" strokeWidth="1"/><circle cx="10" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1"/><path d="M9.5 8.6c1.7 0 3 1.3 3 3.4" stroke="currentColor" strokeWidth="1"/></svg>
    );
    case 'folder': return (
      <svg {...iconProps}><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.2 1.3h4.8a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/></svg>
    );
    case 'crop': return (
      <svg {...iconProps}><path d="M3.5 1v8.5a1 1 0 0 0 1 1H13" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/><path d="M1 3.5h8.5a1 1 0 0 1 1 1V13" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
    );
    case 'eye': return (
      <svg {...iconProps}><path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" strokeWidth="1"/></svg>
    );
    case 'clock': return (
      <svg {...iconProps}><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1"/><path d="M7 4v3.2l2.2 1.3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
    );
    case 'upload': return (
      <svg {...iconProps}><path d="M7 9V2.5M4.5 5L7 2.5 9.5 5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 9.5v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
    );
    case 'layers': return (
      <svg {...iconProps}><path d="M7 1.5l5.5 3L7 7.5 1.5 4.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/><path d="M1.5 7.2L7 10.2l5.5-3M1.5 9.8L7 12.8l5.5-3" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/></svg>
    );
    case 'memory': return (
      <svg {...iconProps}><path d="M3 2.5h6l2 2v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/><path d="M4.5 7h5M4.5 9h3.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
    );
    case 'link': return (
      <svg {...iconProps}><path d="M6 8a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.7.7" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/><path d="M8 6a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 6 11.5l.7-.7" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
    );
  }
}

function ToolIcon({ toolName }: { toolName: string }) {
  const helper = HELPER_TOOLS[toolName];
  if (helper) return <HelperToolIcon icon={helper.icon} />;
  const isSearch = toolName === 'web_search' || toolName === 'browser' || toolName === 'internet_search';
  const isDocs = toolName === 'retrieve_documents';
  const isEmail = toolName === 'gmail' || toolName === 'send_email' || toolName?.startsWith('GMAIL');
  const isDrive = toolName === 'google_drive';
  const isCRM = toolName === 'zoho_crm' || toolName?.startsWith('ZOHO_CRM');
  const isWriting = toolName === 'save-prd' || toolName === 'savePRD'
    || toolName === 'save-plan' || toolName === 'savePlan'
    || toolName === 'save-tasks' || toolName === 'saveTasks'
    || toolName?.startsWith('agent-prd') || toolName?.startsWith('agent-roadmap') || toolName?.startsWith('agent-task')
    || toolName?.startsWith('workflow-prd');
  const isImage = isImageGenTool(toolName) || isDirectorDelegateTool(toolName);
  const isSong = isSongGenTool(toolName) || isProducerDelegateTool(toolName);
  const isVideo = isVideoGenTool(toolName);

  if (isVideo) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="1.5" y="3" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1"/>
      <path d="M11 5.5l2-1.5v6l-2-1.5" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill="none"/>
      <path d="M4.5 5.2l3 1.8-3 1.8z" fill="currentColor"/>
    </svg>
  );

  if (isImage) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1"/>
      <circle cx="5" cy="5.5" r="1" stroke="currentColor" strokeWidth="0.8"/>
      <path d="M2 10l3-3 2.5 2.5L11 6l1 1.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinejoin="round"/>
    </svg>
  );

  if (isSong) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <path d="M5.5 2.5v6.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <path d="M5.5 2.5l5-1v6.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none"/>
      <circle cx="4" cy="10" r="1.5" stroke="currentColor" strokeWidth="1"/>
      <circle cx="9" cy="9" r="1.5" stroke="currentColor" strokeWidth="1"/>
    </svg>
  );

  if (isSearch) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1"/>
      <ellipse cx="7" cy="7" rx="2.5" ry="5.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" strokeWidth="1"/>
      <line x1="2" y1="4.5" x2="12" y2="4.5" stroke="currentColor" strokeWidth="0.8"/>
      <line x1="2" y1="9.5" x2="12" y2="9.5" stroke="currentColor" strokeWidth="0.8"/>
    </svg>
  );

  if (isDocs) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="2.5" y="1.5" width="8" height="11" rx="1" stroke="currentColor" strokeWidth="1"/>
      <line x1="4.5" y1="4.5" x2="9.5" y2="4.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4.5" y1="6.5" x2="9.5" y2="6.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4.5" y1="8.5" x2="7.5" y2="8.5" stroke="currentColor" strokeWidth="1"/>
    </svg>
  );

  if (isEmail) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" strokeWidth="1"/>
      <polyline points="1.5,3.5 7,8 12.5,3.5" stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );

  if (isDrive) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <polygon points="7,1.5 13,12.5 1,12.5" stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );

  if (isCRM) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <circle cx="7" cy="5" r="2.5" stroke="currentColor" strokeWidth="1"/>
      <path d="M1.5 13c0-3.04 2.46-5.5 5.5-5.5s5.5 2.46 5.5 5.5" stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );

  if (isWriting) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="2" y="1.5" width="8" height="11" rx="1" stroke="currentColor" strokeWidth="1"/>
      <line x1="4" y1="4.5" x2="8" y2="4.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4" y1="6.5" x2="8" y2="6.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4" y1="8.5" x2="6.5" y2="8.5" stroke="currentColor" strokeWidth="1"/>
      <path d="M9 9.5l1.5-1.5 1.5 1.5-1.5 1.5z" stroke="currentColor" strokeWidth="0.8" fill="none"/>
    </svg>
  );

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <path d="M9.5 2A3.5 3.5 0 0 0 7 7.5L2.5 12a1.06 1.06 0 1 0 1.5 1.5L8.5 9A3.5 3.5 0 0 0 9.5 2z" stroke="currentColor" strokeWidth="1" fill="none"/>
      <circle cx="9.5" cy="4.5" r="0.75" fill="currentColor"/>
    </svg>
  );
}

function toolLabel(toolName: string, query: string, status: 'loading' | 'done'): { prefix: string; highlight: string } {
    const done = status === 'done';
    // A delegate's "query" is Olmo's instruction to it, which can carry file
    // ids ("(fileId: 5c05…)") — never show ids to the user.
    query = stripIds(query);
    const truncatedQuery = query.length > 60 ? `${query.slice(0, 60)}…` : query;
    const q = query ? `"${truncatedQuery}"` : '';

    if (status === 'loading') {
        if (toolName === 'web_search') return { prefix: 'Searching the web for ', highlight: q };
        if (toolName === 'retrieve_documents') return { prefix: 'Searching your documents for ', highlight: q };
        if (toolName === 'browser') return { prefix: 'Browsing ', highlight: q };
        if (toolName === 'code_exec' || toolName === 'code_execution') return { prefix: 'Running code...', highlight: '' };
        if (toolName === 'save-prd' || toolName === 'savePRD' || toolName?.startsWith('agent-prd') || toolName?.startsWith('workflow-prd')) return { prefix: 'Writing PRD', highlight: query ? ` — ${q}` : '...' };
        if (toolName === 'save-plan' || toolName === 'savePlan' || toolName?.startsWith('agent-roadmap')) return { prefix: 'Building roadmap...', highlight: '' };
        if (toolName === 'save-tasks' || toolName === 'saveTasks' || toolName?.startsWith('agent-task')) return { prefix: 'Creating tasks...', highlight: '' };
        if (isImageGenTool(toolName)) return { prefix: toolName.includes('edit') ? 'Editing image...' : 'Generating image...', highlight: '' };
        if (isSongGenTool(toolName)) return { prefix: 'Generating song...', highlight: '' };
        if (isVideoGenTool(toolName)) return { prefix: 'Generating video...', highlight: '' };
        if (isDirectorDelegateTool(toolName)) return { prefix: 'Generating visual', highlight: '...' };
        if (isProducerDelegateTool(toolName)) return { prefix: 'Generating audio', highlight: '...' };
        if (isPmDelegateTool(toolName)) return { prefix: 'Building plan', highlight: query ? ` — ${q}` : '...' };
        if (isArchitectDelegateTool(toolName)) return { prefix: 'Designing architecture', highlight: query ? ` — ${q}` : '...' };
    }

    if (toolName === 'web_search' || toolName === 'browser') return { prefix: 'Searched the web for ', highlight: q };
    if (toolName === 'retrieve_documents') return { prefix: 'Read documents', highlight: query ? ` — ${q}` : '' };
    if (toolName === 'GMAIL_READ' || toolName === 'gmail') return { prefix: done ? 'Checked Gmail' : 'Checking Gmail', highlight: query ? ` — ${q}` : '' };
    if (toolName === 'GMAIL_SEND' || toolName === 'send_email') return { prefix: done ? 'Sent email to ' : 'Sending email to ', highlight: query };
    if (toolName === 'GCAL_CREATE_EVENT') return { prefix: done ? 'Created event' : 'Creating event', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('GCAL')) return { prefix: done ? 'Checked calendar' : 'Checking calendar', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('ZOHO_CRM')) return { prefix: done ? 'Accessed CRM' : 'Accessing CRM', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('ZOHO_MAIL')) return { prefix: done ? 'Sent email' : 'Sending email', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('ZOHO_CLIQ')) return { prefix: done ? 'Sent message' : 'Sending message', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('GMAIL')) return { prefix: done ? 'Accessed email' : 'Accessing email', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('JIRA')) return { prefix: done ? 'Accessed Jira' : 'Accessing Jira', highlight: query ? ` — ${q}` : '' };
    if (toolName === 'code_execution' || toolName === 'code_exec') return { prefix: 'Ran code', highlight: '' };
    if (toolName === 'save-prd' || toolName === 'savePRD' || toolName?.startsWith('agent-prd') || toolName?.startsWith('workflow-prd')) return { prefix: 'PRD drafted', highlight: '' };
    if (toolName === 'save-plan' || toolName === 'savePlan' || toolName?.startsWith('agent-roadmap')) return { prefix: 'Roadmap built', highlight: '' };
    if (toolName === 'save-tasks' || toolName === 'saveTasks' || toolName?.startsWith('agent-task')) return { prefix: 'Tasks created', highlight: '' };
    if (isImageGenTool(toolName)) return { prefix: toolName.includes('edit') ? 'Image edited' : 'Image generated', highlight: '' };
    if (isSongGenTool(toolName)) return { prefix: 'Song generated', highlight: '' };
    if (isVideoGenTool(toolName)) return { prefix: 'Video generated', highlight: '' };
    if (isDirectorDelegateTool(toolName)) return { prefix: 'Visual created', highlight: '' };
    if (isProducerDelegateTool(toolName)) return { prefix: 'Audio created', highlight: '' };
    if (isPmDelegateTool(toolName)) return { prefix: 'Plan built', highlight: query ? ` — ${q}` : '' };
    if (isArchitectDelegateTool(toolName)) return { prefix: 'Architecture designed', highlight: query ? ` — ${q}` : '' };

    if (toolName === 'internet_search') return { prefix: done ? 'Searched the web for ' : 'Searching the web for ', highlight: q };
    const helper = HELPER_TOOLS[toolName];
    if (helper) {
      // The skill row names the skill ("Loaded skill — UGC avatar creator"); the
      // other helpers' arguments are internal, so they show the label alone.
      const skill = toolName === 'skill' ? skillDisplayName(query) : '';
      return { prefix: done ? helper.done : helper.loading, highlight: skill ? ` — ${skill}` : '' };
    }

    const friendly = toolName.replace(/_/g, ' ').toLowerCase();
    return { prefix: done ? `Used ${friendly}` : `Using ${friendly}`, highlight: query ? ` — ${q}` : '' };
}

const DOMAIN_PALETTE = [
  '#4f46e5', '#7c3aed', '#db2777', '#dc2626', '#d97706',
  '#16a34a', '#0284c7', '#0891b2', '#be185d', '#b45309',
];

function domainColor(domain: string): string {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = domain.charCodeAt(i) + ((h << 5) - h);
  return DOMAIN_PALETTE[Math.abs(h) % DOMAIN_PALETTE.length];
}

// The vendors report no progress: a generation is one request that returns the
// finished file. So the bar is an estimate from typical duration, like ChatGPT's.
// It eases toward 95% and holds there until the real result replaces the
// skeleton, so it never claims done early and never goes backwards.
export const EXPECTED_MS = { image: 22_000, audio: 35_000, video: 90_000 } as const;

export function estimatedProgress(elapsedMs: number, expectedMs: number): number {
  if (elapsedMs <= 0) return 0;
  // ~86% at the expected time, then a slow crawl toward the 95% cap.
  return Math.min(95, Math.floor(95 * (1 - Math.exp((-2 * elapsedMs) / expectedMs))));
}

// "9:16" -> 9/16. Null for anything unparseable, so the skeleton stays 16:9.
export function parseAspectRatio(value: string | undefined): number | null {
  const m = value ? /^(\d+):(\d+)$/.exec(value) : null;
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

function MediaProgressSkeleton({ type, aspectRatio, complete }: { type: 'image' | 'audio' | 'video'; aspectRatio?: string; complete?: boolean }) {
  // Audio has no picture, so it keeps the default card shape.
  const ratio = type === 'audio' ? null : parseAspectRatio(aspectRatio);
  const portrait = ratio !== null && ratio < 1;
  // Mounts when generation actually starts (after approval), so that is t=0.
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    // A tile whose batch item already finished (batchProgress.done) holds at
    // 100% rather than ticking — nothing left to estimate.
    if (complete) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [complete]);
  const pct = complete ? 100 : estimatedProgress(now - startedAt, EXPECTED_MS[type]);

  return (
    <div
      data-testid="media-progress-skeleton"
      // Same widths as InlineAttachmentCard (180px portrait, 240px otherwise) so
      // the finished media swaps in without the card changing size.
      style={ratio ? { aspectRatio: String(ratio) } : undefined}
      className={`relative mt-1.5 w-full ${portrait ? 'max-w-[180px]' : 'max-w-[240px]'} ${ratio ? '' : 'aspect-video'} rounded-xl border border-border/60 overflow-hidden flex items-center justify-center ${TYPE_STYLES[type].bg}`}
    >
      <span className="absolute top-1.5 left-1.5 z-10 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
        {TYPE_BADGES[type]}
      </span>
      {/* Rose sweep: the white one was invisible on the light theme. */}
      {!complete && <div className="absolute inset-0 bg-gradient-to-r from-transparent via-[#E69DB8]/25 to-transparent animate-shimmer" />}
      <span data-testid="media-progress-pct" className="relative z-10 text-xs font-medium tabular-nums text-muted-foreground">
        {pct}%
      </span>
      <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-foreground/10">
        <div
          data-testid="media-progress-bar"
          className="h-full bg-[var(--shimmer-accent)] transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// N skeleton tiles side by side for a batch generation (generate_images/
// generate_videos), instead of ToolCallCard's usual single skeleton — the
// only way N images-in-flight ever read as N, not one growing bar. `total`
// comes from batchProgress.total once known, or from generationCount (the
// generation_started event's item count) before the first item settles;
// `done` (from batchProgress) marks the leading tiles complete.
function MediaProgressTiles({ type, aspectRatio, total, done }: { type: 'image' | 'audio' | 'video'; aspectRatio?: string; total: number; done: number }) {
  return (
    <div className="flex flex-wrap gap-2" data-testid="media-progress-tiles">
      {Array.from({ length: total }, (_, i) => (
        <MediaProgressSkeleton key={i} type={type} aspectRatio={aspectRatio} complete={i < done} />
      ))}
    </div>
  );
}

// Whether this tool renders as an image tile — used both for the media
// skeleton (isImageGenTool alone) and for grouping consecutive tool-call
// rows into one wrapping line (below), which also groups the Director
// delegate wrapper (see isDirectorDelegateTool's comment: it stands in for
// a whole generate_image/generate_video turn that never reaches this card
// as its own event).
export function isImageTileTool(toolName: string): boolean {
  return isImageGenTool(toolName) || isDirectorDelegateTool(toolName);
}

// Groups consecutive image-generation rows (several single generate_image
// calls, or Director delegate calls, back to back in the same turn) so the
// caller can render each group's cards in one flex-wrap row instead of one
// per line. Non-image rows, and any image row that isn't adjacent to
// another, come back as their own singleton group so callers can treat
// every group uniformly.
// A show_files call that re-shows a file an earlier call in the same trace
// already rendered (a generation, then show_files of that still and its
// close-up) would put the same image on screen twice. Keep only the files not
// shown yet; drop the call if nothing new is left.
export function withoutRepeatedTraceFiles<T extends { toolName: string; result?: Record<string, unknown> }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const files = extractResultFiles(item.toolName, item.result);
    if (item.toolName === 'show_files' && files.length > 0 && Array.isArray(item.result?.files)) {
      const fresh = (item.result!.files as Array<Record<string, unknown>>).filter(f => typeof f.fileId !== 'string' || !seen.has(f.fileId));
      files.forEach(f => seen.add(f.fileId));
      if (fresh.length === 0) continue;
      out.push({ ...item, result: { ...item.result, files: fresh } });
      continue;
    }
    // A delegate's result repeats every file its own calls made, and those were
    // already relayed one by one as they finished: keep only the new ones.
    if ((isDirectorDelegateTool(item.toolName) || isProducerDelegateTool(item.toolName)) && files.length > 0) {
      const entries = (item.result!.subAgentToolResults as Array<Record<string, unknown>>)
        .filter(e => typeof e.toolName === 'string' && extractResultFiles(e.toolName, e.result as Record<string, unknown> | undefined).some(f => !seen.has(f.fileId)));
      files.forEach(f => seen.add(f.fileId));
      out.push({ ...item, result: { ...item.result, subAgentToolResults: entries } });
      continue;
    }
    files.forEach(f => seen.add(f.fileId));
    out.push(item);
  }
  return out;
}

export function groupImageToolCalls<T extends { toolName: string }>(items: T[]): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (isImageTileTool(item.toolName) && last && last.every(t => isImageTileTool(t.toolName))) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups;
}

export function isMediaGenDelegateOrTool(toolName: string): boolean {
  return isImageGenTool(toolName) || isSongGenTool(toolName) || isVideoGenTool(toolName)
    || isDirectorDelegateTool(toolName) || isProducerDelegateTool(toolName);
}

/** Removes uuids and "fileId: …" mentions from label text. */
export function stripIds(text: string): string {
  return text
    .replace(/\(?\s*file ?ids?\s*:?\s*[0-9a-f]{8}-[0-9a-f-]{27}\s*\)?/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// agent-director also makes narration and video, so before its generation tool
// starts, read Olmo's instruction to it to pick the right word and tile.
// Guessed from the brief while the job runs. Its header lines ("flow:
// animation character ad", "style: …") name the whole ad, not this step, so
// they are ignored. Once the job is done the files it returned decide.
export function directorMediaKind(query: string): 'image' | 'audio' | 'video' {
  const body = query.split('\n').filter(line => !/^\s*[a-zA-Z_]+\s*:/.test(line)).join('\n');
  if (/\b(narration|voice-?over|voice over|audio|song|music)\b/i.test(body)) return 'audio';
  if (/\b(video|clip|clips|animate|lip-?sync)\b/i.test(body)) return 'video';
  return 'image';
}

function kindFromFiles(files: Array<{ fileType: string }>): 'image' | 'audio' | 'video' | null {
  if (files.some(f => f.fileType.startsWith('video/'))) return 'video';
  if (files.some(f => f.fileType.startsWith('audio/'))) return 'audio';
  if (files.some(f => f.fileType.startsWith('image/'))) return 'image';
  return null;
}

export function ToolCallCard({ toolName, query, prompt, status, results, result, generationStarted, aspectRatio, batchProgress, mediaCount, freshUrls, statusText, statusDetails, liveKind }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(true);
  const hasResults = status === 'done' && !!results?.length;
  // The orchestrator closes a cancelled generation out with { cancelled: true } so the
  // row stops spinning; it must not read as a finished "Visual created" with a green check.
  const cancelled = status === 'done' && result?.cancelled === true;
  const failureReason = status === 'done' && !cancelled && isMediaGenTool(toolName) ? mediaGenFailureReason(toolName, result) : null;
  const cardAwaitingApproval = useContext(AwaitingApprovalContext);
  const isDelegate = isDirectorDelegateTool(toolName) || isProducerDelegateTool(toolName);
  // A delegate call is just "the specialist is working" until its generation tool starts.
  // Before that it is reasoning / writing the prompt, and a generating skeleton reads as
  // "the image has already started" (it may still be waiting on the approval card).
  const preparing = status === 'loading' && isDelegate && !generationStarted && !cardAwaitingApproval;
  const awaitingApproval = cardAwaitingApproval && status === 'loading' && isMediaGenDelegateOrTool(toolName);
  // An animated ad's row read "Audio created" because its brief mentions narration
  // (2026-10-06): when the job is done, what it made decides the word.
  // While it runs, the step it is on now decides (a UGC ad starts with stills
  // and then makes clips; its row said "Generating image…" over the clips).
  const directorKind = isDirectorDelegateTool(toolName)
    ? (status === 'done' ? kindFromFiles(extractResultFiles(toolName, result)) : liveKind ?? null) ?? directorMediaKind(prompt || query)
    : null;
  // A finished Director row whose files were all shown above it already (the
  // repeats are folded away) has nothing of its own: it said "Video created"
  // after making one still, guessed from the brief (2026-10-06).
  const directorDoneEmpty = status === 'done' && isDirectorDelegateTool(toolName) && Array.isArray(result?.subAgentToolResults) && extractResultFiles(toolName, result).length === 0;
  const liveDirectorLabel = status === 'loading' && isDirectorDelegateTool(toolName) && liveKind
    ? (liveKind === 'video' ? 'Making the video clips' : liveKind === 'audio' ? 'Recording the voice' : 'Making the pictures')
    : null;
  const label = toolLabel(toolName, query, status);
  // The director also records narration and renders video: name what it made.
  const labelPrefix = directorDoneEmpty && label.prefix === 'Visual created' ? 'Done'
    : status === 'done' && directorKind === 'audio' && label.prefix === 'Visual created' ? 'Audio created'
    : status === 'done' && directorKind === 'video' && label.prefix === 'Visual created' ? 'Video created'
    : liveDirectorLabel ?? label.prefix;
  const { highlight } = label;
  const preparingLabel = isProducerDelegateTool(toolName) || directorKind === 'audio' ? 'Preparing your audio…'
    : directorKind === 'video' ? 'Preparing your video…' : 'Preparing your image…';
  const prefix = cancelled ? 'Cancelled' : (failureReason ?? (awaitingApproval ? 'Waiting for your approval' : preparing ? (statusText ? `${statusText}…` : preparingLabel) : labelPrefix));
  // Who/what the delegate is working on, kept visible through approval and
  // generation so each loading tile has a person behind it.
  const showStatusDetails = status === 'loading' && !!statusDetails?.length;
  // Placeholder shaped like InlineAttachmentCard's own thumbnail chip, so the
  // real image/song/video attachment swaps in without the layout jumping once
  // it lands. 'image' / 'audio' / 'video' picks the tile styling
  // (TYPE_STYLES/TYPE_BADGES already define all three) — song results render
  // as an audio attachment, video results as a video attachment.
  const mediaSkeletonType = directorKind ? directorKind
    : isImageGenTool(toolName) ? 'image'
    : (isSongGenTool(toolName) || isProducerDelegateTool(toolName)) ? 'audio'
    : isVideoGenTool(toolName) ? 'video' : null;
  const showMediaSkeleton = status === 'loading' && mediaSkeletonType !== null && !awaitingApproval && !preparing;
  // Total tile count: batchProgress.total once the batch tool's own progress events
  // have arrived, else generation_started's count (known from the very first event),
  // else undefined — a single call with neither falls back to the one-tile skeleton.
  const tileTotal = batchProgress?.total ?? mediaCount;
  const tileDone = batchProgress?.done ?? 0;
  // Real thumbnails for a completed generation/show_files call — rendered right on
  // this row, not only once the whole turn finishes as a message.attachment (see
  // extractResultFiles above). Never shown for a cancelled/failed result.
  const resultFiles = status === 'done' && !cancelled && !failureReason ? extractResultFiles(toolName, result) : [];
  // Which pixel loader a running media row shows: pictures, video or audio.
  const pixelKind = status === 'loading' ? (mediaSkeletonType ?? null) : null;
  const elapsed = useElapsedLabel(status === 'loading' && !!pixelKind);
  // A real detail (a search query, a file name) reads as a chip beside the label.
  const chipText = highlight && highlight.trim() && !/^\.+$/.test(highlight.trim()) ? highlight.trim() : '';

  // A batch's tiles need the full row: next to another card in a wrapping
  // group they were squeezed into one tall column.
  const fullWidth = (showMediaSkeleton && !!tileTotal && tileTotal > 1) || resultFiles.length > 1;
  return (
    <div className={`my-1.5 text-foreground${fullWidth ? " basis-full w-full" : ""}`}>
      <div
        className="flex items-center gap-2"
        style={{ cursor: hasResults ? 'pointer' : 'default' }}
        onClick={() => hasResults && setExpanded(e => !e)}
      >
        {/* Status first, on the left: the pixel loader while media is being
            made, then a check, a cross or a warning. The detail (a query, a
            file name) sits beside the label as a chip. */}
        <span className="h-4 w-4 shrink-0 flex items-center justify-center">
          {status === 'loading' ? (
            pixelKind && !awaitingApproval ? <PixelLoader kind={pixelKind} label={prefix} /> : (
              <span className="flex gap-[2px] items-center">
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground opacity-60 animate-bounce [animation-delay:-0.15s]" />
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground opacity-30 animate-bounce" />
              </span>
            )
          ) : cancelled ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground" aria-label="cancelled">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          ) : failureReason ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-amber-600 dark:text-amber-400" aria-label="needs a look">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M7 4v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <circle cx="7" cy="9.6" r="0.7" fill="currentColor"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground" aria-label="done">
              <path d="M2.5 7L5.5 10L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </span>
        {/* Media rows show only their status: the pixel loader while working,
            then a plain check. A picture icon beside either says it twice.
            Search, files and helpers keep their icon. */}
        {!isMediaGenDelegateOrTool(toolName) && <ToolIcon toolName={toolName} />}

        <span className={`text-sm font-semibold truncate ${status === 'loading' ? 'shimmer-text' : ''}`}>
          {prefix}
          {highlight && !chipText && !awaitingApproval && !preparing && !cancelled && (
            <span className="font-medium" style={{ color: 'var(--color-text-primary, inherit)' }}>
              {highlight}
            </span>
          )}
        </span>
        {chipText && !awaitingApproval && !preparing && !cancelled && (
          <span className="min-w-0 max-w-[50%] truncate font-mono text-xs text-muted-foreground bg-muted/60 rounded-md px-2 py-0.5" data-testid="tool-detail-chip">{chipText}</span>
        )}
        {status === 'loading' && pixelKind && !awaitingApproval && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums shrink-0">{elapsed}</span>
        )}
        {status === 'done' && hasResults && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            className={`shrink-0 transition-transform text-muted-foreground ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}

      </div>

      {showStatusDetails && (
        <ul className="mt-1 ml-6 space-y-0.5 text-xs text-muted-foreground" data-testid="tool-status-details">
          {statusDetails!.map((line, i) => <li key={i} className="truncate">{line}</li>)}
        </ul>
      )}

      {showMediaSkeleton && mediaSkeletonType && (
        tileTotal && tileTotal > 1
          ? <MediaProgressTiles type={mediaSkeletonType} aspectRatio={aspectRatio} total={tileTotal} done={tileDone} />
          : <MediaProgressSkeleton type={mediaSkeletonType} aspectRatio={aspectRatio} />
      )}

      {resultFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-1.5" data-testid="tool-result-media">
          {resultFiles.map(f => (
            <InlineAttachmentCard
              key={f.fileId}
              file={{ id: f.fileId, fileId: f.fileId, name: f.name, type: f.fileType, size: f.size } satisfies MessageAttachment}
              url={freshUrls?.[f.fileId] ?? null}
            />
          ))}
        </div>
      )}

      {hasResults && expanded && (
        <div className="flex gap-2.5 mt-1.5 pl-0.5">
          <div className="w-3 shrink-0 border-l border-b border-foreground/20 rounded-bl-md" style={{ marginTop: '-4px', height: '0.85em' }} />
          <div className="space-y-[5px] flex-1 min-w-0">
            {results!.slice(0, 3).map((r, i) => (
              <div key={i} className="flex items-center gap-2 min-w-0">
                <div
                  className="shrink-0 flex items-center justify-center select-none"
                  style={{
                    width: 14, height: 14, borderRadius: 2,
                    background: domainColor(r.domain),
                    color: '#fff', fontSize: 8, fontWeight: 700, lineHeight: 1,
                  }}
                >
                  {(r.favicon ?? r.domain.charAt(0)).toUpperCase()}
                </div>
                <span className="text-xs text-foreground truncate flex-1">{r.title}</span>
                <span className="text-xs text-muted-foreground shrink-0">{r.domain}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

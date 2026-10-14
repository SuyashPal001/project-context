// One element = one graphic beat. startSeconds/endSeconds are relative to the
// presenter video's own timeline (the phrase-timing from silencedetect, per
// presenter-video's director.md), not to this composition's own cues.
export type GraphicsElement =
  | { type: 'title_card'; startSeconds: number; endSeconds: number; kicker?: string; name: string; role?: string }
  | { type: 'info_cards'; startSeconds: number; endSeconds: number; headline: string; cards: { label: string; value: string }[] }
  | { type: 'follow_card'; startSeconds: number; endSeconds: number; handle: string; site?: string }
  | { type: 'captions'; startSeconds: number; endSeconds: number; text: string; keyword?: string }
  | { type: 'corner_mark'; startSeconds: number; endSeconds: number; text?: string }
  | { type: 'screen_walkthrough'; startSeconds: number; endSeconds: number; screenshotUrl: string; urlText?: string; zoomTo?: number; cursor?: { xPct: number; yPct: number } }
  | { type: 'compare'; startSeconds: number; endSeconds: number; left: { label: string; value: string }; right: { label: string; value: string } }

export interface GraphicsOverlayProps {
  aspectRatio: '16:9' | '9:16'
  durationSeconds: number
  fps: number
  elements: GraphicsElement[]
}

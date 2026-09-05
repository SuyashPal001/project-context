// Central feature flags. Set to false to completely hide a feature from the UI.
// These are independent of plan/entitlements — no plan change can surface a false flag.
export const FEATURE_FLAGS = {
    plans:        false,  // Projects / Plans section — hidden until UX is settled
    board:        false,  // Board (Kanban) section — hidden until UX is settled
    chatUpload:   true,   // + attach button in chat input
    chatCanvas:   true,   // Canvas panel and toggle button in chat
    chatVoice:    false,  // Voice orb / mic button in chat
} as const;

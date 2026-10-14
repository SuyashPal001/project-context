// Settings, not code: switch 3.6/3.8 (or Pro) without a deploy of new code.
// 3.8 Flash's price reportedly doubles on 2027-01-01 (spec §8a).
export const watchModel = (): string => process.env.VIDEO_WATCH_MODEL || 'gemini-3.8-flash'
export const checkModel = (): string => process.env.VIDEO_CHECK_MODEL || 'gemini-3.8-flash'

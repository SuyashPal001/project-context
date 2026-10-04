// The cast's terseTag and styleLock must appear in every prompt that uses the
// cast. This used to be a refusal (IDENTITY_ANCHOR_MISSING), but the refusal
// came after the user had already approved the paid card, so a reworded prompt
// cost them a second approval for nothing (UGC wafer run, 2026-10-05). The tool
// now adds whichever string is missing itself: the subject first, the look last.
export function withIdentityAnchor(prompt: string, anchor?: { terseTag: string; styleLock: string }): string {
  if (!anchor) return prompt
  let out = prompt.trim()
  if (anchor.terseTag && !out.includes(anchor.terseTag)) out = `${anchor.terseTag.replace(/\.+$/, '')}. ${out}`
  if (anchor.styleLock && !out.includes(anchor.styleLock)) out = `${out.replace(/\.+$/, '')}. ${anchor.styleLock.replace(/\.+$/, '')}.`
  return out
}

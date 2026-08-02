/**
 * Terminal-status guard for handover packs.
 *
 * A signed pack is a record, not a draft — the client has put their name to it
 * and holds a link to what they signed. A revoked pack is deliberately dead.
 * Neither may be mutated or re-sent.
 *
 * This lives in lib/ rather than in routes/handover.ts because both the CRUD
 * router and the lifecycle router need it, and handover.ts already imports the
 * lifecycle router — importing back would be circular. Keeping one
 * implementation means a future terminal status is enforced everywhere at once
 * instead of being added to six call sites and missed in two.
 */
export function assertEditable(pack: { status: string }): string | null {
  if (pack.status === 'signed') return 'This pack has been signed and can no longer be edited';
  if (pack.status === 'revoked') return 'This pack has been revoked';
  return null;
}

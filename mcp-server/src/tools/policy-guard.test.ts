import { describe, it, expect, vi } from 'vitest';
import { assertActionAllowed } from './policy-guard';

/**
 * F-03 — the agent policy guard must fail closed.
 *
 * The bug: guardPolicy opened with `if (!ctx.agentId) return;` while
 * `x-agent-id` was an optional header. Omitting one header skipped checkPolicy
 * entirely, so neither `blocked` nor `requiresApproval` was ever evaluated — and
 * requiresApproval is the human-in-the-loop gate for an agent sending mail on an
 * organisation's behalf. It was defeated by leaving out a header rather than by
 * defeating any credential.
 *
 * A guard that cannot evaluate its policy must deny, not permit.
 */

const allow = vi.fn().mockResolvedValue({ blocked: false, requiresApproval: false });

describe('assertActionAllowed', () => {
  it('permits an action the policy allows', async () => {
    await expect(
      assertActionAllowed({ tenantId: 't1', agentId: 'a1' }, 'GMAIL_SEND_EMAIL', allow),
    ).resolves.toBeUndefined();
  });

  it('refuses when the agent context is missing', async () => {
    // The exact bypass: no x-agent-id header supplied.
    const check = vi.fn();
    await expect(
      assertActionAllowed({ tenantId: 't1', agentId: undefined }, 'GMAIL_SEND_EMAIL', check),
    ).rejects.toThrow(/agent context/i);
    expect(check).not.toHaveBeenCalled();
  });

  it('refuses an action the policy blocks', async () => {
    const check = vi.fn().mockResolvedValue({ blocked: true, requiresApproval: false });
    await expect(
      assertActionAllowed({ tenantId: 't1', agentId: 'a1' }, 'GMAIL_SEND_EMAIL', check),
    ).rejects.toThrow(/blocked/i);
  });

  it('refuses an action awaiting human approval', async () => {
    const check = vi.fn().mockResolvedValue({ blocked: false, requiresApproval: true });
    await expect(
      assertActionAllowed({ tenantId: 't1', agentId: 'a1' }, 'GMAIL_SEND_EMAIL', check),
    ).rejects.toThrow(/approval/i);
  });

  it('refuses when the policy lookup itself fails', async () => {
    const check = vi.fn().mockRejectedValue(new Error('db unavailable'));
    // A policy store outage must not become an open door.
    await expect(
      assertActionAllowed({ tenantId: 't1', agentId: 'a1' }, 'GMAIL_SEND_EMAIL', check),
    ).rejects.toThrow();
  });

  it('guards reads as well as writes', async () => {
    const check = vi.fn().mockResolvedValue({ blocked: true, requiresApproval: false });
    // Mailbox reads and search were previously unguarded entirely.
    await expect(
      assertActionAllowed({ tenantId: 't1', agentId: 'a1' }, 'GMAIL_SEARCH_EMAILS', check),
    ).rejects.toThrow(/blocked/i);
    await expect(
      assertActionAllowed({ tenantId: 't1', agentId: 'a1' }, 'GMAIL_READ_EMAIL', check),
    ).rejects.toThrow(/blocked/i);
  });
});

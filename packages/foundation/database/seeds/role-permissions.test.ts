import { describe, it, expect } from 'vitest';
import { ROLE_PERMISSIONS } from './role-permissions';

describe('ROLE_PERMISSIONS — credits:create exclusion', () => {
  // Minting credits is an ops action, not tenant self-service: POST
  // /credits/grants takes an arbitrary amountMicro, so a customer's own
  // owner/admin must not be able to grant themselves unbounded credits.
  // This pins the exclusion so nobody silently restores it by widening
  // ALL_PERMS later.
  it('owner does not carry credits:create', () => {
    expect(ROLE_PERMISSIONS.owner).not.toContain('credits:create');
  });

  it('admin does not carry credits:create', () => {
    expect(ROLE_PERMISSIONS.admin).not.toContain('credits:create');
  });

  it('owner and admin still carry credits:read', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('credits:read');
    expect(ROLE_PERMISSIONS.admin).toContain('credits:read');
  });

  it('member carries credits:read only, never credits:create', () => {
    expect(ROLE_PERMISSIONS.member).toContain('credits:read');
    expect(ROLE_PERMISSIONS.member).not.toContain('credits:create');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('seeded storage limits', () => {
  const source = readFileSync(join(__dirname, 'plan-entitlements.ts'), 'utf8');

  it('gives free 20GB, not the original 1GB', () => {
    // 1GB was tight enough to read as stingy and to block ordinary use. The
    // ceiling exists to stop free file hosting, not to sell upgrades.
    expect(source).toMatch(/free[\s\S]*?storage_gb:\s*\{\s*valueLimit:\s*20\s*\}/);
  });

  it('gives enterprise unlimited rather than a number', () => {
    // Enterprise storage is pay-as-you-go, so it must resolve unlimited and
    // skip both gates. A numeric limit would block a paying customer.
    expect(source).toMatch(/enterprise[\s\S]*?storage_gb:\s*\{\s*unlimited:\s*true\s*\}/);
  });
});

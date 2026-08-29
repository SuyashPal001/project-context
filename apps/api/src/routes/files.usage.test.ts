import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storagePercent } from './files.quota';

describe('storagePercent', () => {
  it('is 0 when nothing is used', () => {
    expect(storagePercent(0, 100)).toBe(0);
  });

  it('rounds to a whole percent', () => {
    expect(storagePercent(505, 1000)).toBe(51);
  });

  it('is 0 for an unlimited plan, whose limitBytes is meaningless', () => {
    // Dividing by the placeholder 0 would yield Infinity and light up the
    // meter permanently for the one plan that should never see it.
    expect(storagePercent(999, 0)).toBe(0);
  });

  it('clamps above the limit rather than exceeding 100', () => {
    // Reachable: a tenant already over quota when enforcement first ships.
    expect(storagePercent(200, 100)).toBe(100);
  });
});

describe('usage route wiring', () => {
  const source = readFileSync(join(__dirname, 'files.ts'), 'utf8');

  it('registers /usage before the /:id routes', () => {
    // Hono matches in registration order, so a /:id route registered first
    // would swallow "usage" as an id and this endpoint would never be reached.
    const usageAt = source.indexOf("filesRoutes.get('/usage'");
    const idAt = source.indexOf("filesRoutes.get('/:id'");
    expect(usageAt).toBeGreaterThan(-1);
    if (idAt > -1) expect(usageAt).toBeLessThan(idAt);
  });
});

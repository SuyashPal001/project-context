import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The gate is only real if it runs before the URL is signed. Checking after
 * would hand out a working upload URL and then refuse — the bytes still land.
 *
 * These are source-order assertions rather than request-level tests because
 * there is no integration harness here that can stand up Hono against a real
 * database. They prove the wiring, not the response; the response is covered
 * by the manual verification steps in the plan.
 */
describe('files upload route wiring', () => {
  const source = readFileSync(join(__dirname, 'files.ts'), 'utf8');

  it('checks the quota before calling getUploadUrl', () => {
    const decideAt = source.indexOf('decideUpload(');
    const signAt = source.indexOf('storageService.getUploadUrl(');
    expect(decideAt).toBeGreaterThan(-1);
    expect(signAt).toBeGreaterThan(-1);
    expect(decideAt).toBeLessThan(signAt);
  });

  it('passes the declared size to the signer', () => {
    expect(source).toMatch(/getUploadUrl\(\{[\s\S]*?size,[\s\S]*?\}\)/);
  });

  it('accepts size as optional, so callers can be migrated after this ships', () => {
    expect(source).toMatch(/size:\s*z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/);
  });

  it('rejects with 413, the status that means the payload is too large', () => {
    expect(source).toMatch(/413/);
  });

  it('names the concrete numbers in the rejection payload', () => {
    // This rejection is the only place in the product where a storage limit is
    // ever stated, so the numbers have to travel with it.
    expect(source).toMatch(/maxBytes:/);
    expect(source).toMatch(/limitBytes:/);
  });
});

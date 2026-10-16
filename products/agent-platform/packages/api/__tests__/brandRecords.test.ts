import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('@serverless-saas/storage', () => ({ storageService: { getDownloadUrl: vi.fn() } }));

import { toBrandRecord, effectiveImportStatus, mergeImport, IMPORT_STALE_MS } from '../lib/brandRecords';
import { brandFillSchema, brandPatchSchema } from '../lib/brandSchema';
import type { CreativeBrand } from '@serverless-saas/agent-schema/creativeBrand';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const row = (over: Partial<CreativeBrand> = {}): CreativeBrand => ({
  id: 'b1', tenantId: 't1', name: null, oneLiner: null, audience: null, region: 'IN', toneWords: [],
  emojiPolicy: 'minimal', signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null,
  colors: {}, headlineFont: null, logoFileId: null, faviconFileId: null, mascotFileId: null,
  sourceType: null, sourceValue: null, importStatus: 'idle', importError: null, importStartedAt: null,
  importedAt: null, editedByUser: [], createdBy: null, createdAt: NOW, updatedAt: NOW, ...over,
});
const fill = (over: Record<string, unknown> = {}) => brandFillSchema.parse({
  name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women 22-35 in Indian cities',
  region: 'IN', toneWords: ['warm', 'caring', 'honest'], emojiPolicy: 'minimal',
  signaturePhrases: ['Goodness Inside', 'made up phrase'], ctaExamples: ['Shop now'],
  voiceNotes: 'Natural, not chemical-free claims.', colors: { primary: '#00a651', accent: 'green' },
  headlineFont: 'Poppins', ...over,
});

describe('toBrandRecord', () => {
  it('reports readiness from name, audience and tone words', () => {
    expect(toBrandRecord(row(), {}, NOW)).toMatchObject({ ready: false, missing: ['name', 'audience', 'voice'] });
    const full = toBrandRecord(row({ name: 'X', audience: 'Y', toneWords: ['warm'] }), {}, NOW);
    expect(full).toMatchObject({ ready: true, missing: [] });
  });

  it('carries image urls and leaves images null when there is no file', () => {
    const r = toBrandRecord(row({ logoFileId: 'f1' }), { logo: 'https://s3/logo' }, NOW);
    expect(r.logo).toEqual({ fileId: 'f1', url: 'https://s3/logo' });
    expect(r.favicon).toBeNull();
  });
});

describe('effectiveImportStatus', () => {
  it('reports an import running longer than 3 minutes as failed', () => {
    const started = new Date(NOW.getTime() - IMPORT_STALE_MS - 1);
    expect(effectiveImportStatus(row({ importStatus: 'importing', importStartedAt: started }), NOW).status).toBe('failed');
  });

  it('keeps a recent import as importing', () => {
    const started = new Date(NOW.getTime() - 10_000);
    expect(effectiveImportStatus(row({ importStatus: 'importing', importStartedAt: started }), NOW).status).toBe('importing');
  });
});

describe('mergeImport', () => {
  it('fills empty fields and drops signature phrases not in the source text', () => {
    const patch = mergeImport(row(), fill(), 'Welcome to Mamaearth. goodness inside every bottle.');
    expect(patch.name).toBe('Mamaearth');
    expect(patch.signaturePhrases).toEqual(['Goodness Inside']);
    expect(patch.colors).toEqual({ primary: '#00A651' });
  });

  it('never overwrites a field the user edited', () => {
    const patch = mergeImport(row({ name: 'My Name', editedByUser: ['name', 'colors'] }), fill(), 'goodness inside');
    expect(patch).not.toHaveProperty('name');
    expect(patch).not.toHaveProperty('colors');
    expect(patch.audience).toBe('Women 22-35 in Indian cities');
  });

  it('never writes banned phrases and skips empty AI values', () => {
    const patch = mergeImport(row({ oneLiner: 'Kept' }), fill({ oneLiner: '', bannedPhrases: ['x'] }), '');
    expect(patch).not.toHaveProperty('bannedPhrases');
    expect(patch).not.toHaveProperty('oneLiner');
  });
});

describe('brandPatchSchema', () => {
  it('rejects unknown keys and clears with null', () => {
    expect(brandPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(brandPatchSchema.parse({ oneLiner: '' })).toEqual({ oneLiner: null });
  });
});

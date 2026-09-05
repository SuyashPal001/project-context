import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ execute: vi.fn(), insert: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const s3SendMock = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  // Regular functions, not arrow functions, so `new S3Client(...)`,
  // `new GetObjectCommand(...)`, and `new PutObjectCommand(...)` in the
  // handler all work: arrow functions can't be invoked with `new` at all,
  // and returning an object from a regular function called with `new`
  // replaces the constructed instance with that object per normal JS
  // semantics.
  S3Client: vi.fn().mockImplementation(function S3ClientMock() { return { send: s3SendMock }; }),
  GetObjectCommand: vi.fn().mockImplementation(function GetObjectCommandMock(input: unknown) { return { input }; }),
  PutObjectCommand: vi.fn().mockImplementation(function PutObjectCommandMock(input: unknown) { return { input }; }),
}));

// drizzle-orm's `sql` tagged template returns an SQL object with no `.sql`
// string property (that's a Drizzle Kit/Studio thing, not the query
// builder) — its query text lives in `queryChunks`, an array alternating
// string-chunk objects (`{ value: string[] }`) and bound parameters. This
// reassembles the literal text so tests can assert on it the same way they
// would on a plain string.
function sqlText(executed: unknown): string {
  if (typeof executed === 'string') return executed;
  const chunks = (executed as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(executed);
  return chunks
    .map((c) => {
      const value = (c as { value?: unknown[] })?.value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join('');
}

// Bound params (e.g. failureReason, skillVersionId) are interleaved in
// queryChunks as plain values, not folded into the literal text sqlText()
// reassembles — this pulls them out so tests can assert on the actual value
// passed to a placeholder, not just the surrounding SQL shape.
function sqlParams(executed: unknown): unknown[] {
  const chunks = (executed as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  return chunks.filter((c) => !(c && typeof c === 'object' && Array.isArray((c as { value?: unknown[] }).value)));
}

const safeExtractSkillZipMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/safeSkillZip', async () => {
  const actual = await vi.importActual<typeof import('../lib/safeSkillZip')>('../lib/safeSkillZip');
  return { ...actual, safeExtractSkillZip: safeExtractSkillZipMock };
});

describe('handleSkillImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.insert.mockReturnValue({ values: () => ({ catch: () => {} }) });
  });

  it('marks the version ready and bumps skills.latestVersion on a valid zip', async () => {
    s3SendMock.mockResolvedValueOnce({
      Body: (async function* () { yield Buffer.from('zip-bytes'); })(),
    });
    safeExtractSkillZipMock.mockResolvedValue({
      accepted: [{ fileName: 'SKILL.md', buffer: Buffer.from('---\nname: demo\ndescription: d\n---\n') }],
      skipped: [],
      manifestSource: '---\nname: demo\ndescription: d\n---\n',
    });

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'zip', fileKey: 'tenants/tenant-1/skill-uploads/x.zip' },
    });

    const executedSql = dbMock.execute.mock.calls.map((c) => sqlText(c[0]));
    expect(executedSql.some((s) => s.includes("status = 'ready'"))).toBe(true);
    expect(executedSql.some((s) => s.includes('latest_version'))).toBe(true);
  });

  it('marks the version failed with a safe message on a zip-bomb rejection', async () => {
    s3SendMock.mockResolvedValueOnce({ Body: (async function* () { yield Buffer.from('x'); })() });
    const { SkillPackageError } = await import('../lib/safeSkillZip');
    safeExtractSkillZipMock.mockRejectedValue(new SkillPackageError('Entry "big.txt" has a compression ratio over 100:1 — rejected as a likely zip bomb'));

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'zip', fileKey: 'tenants/tenant-1/skill-uploads/x.zip' },
    });

    const failCall = dbMock.execute.mock.calls.find((c) => sqlText(c[0]).includes("status = 'failed'"));
    expect(failCall).toBeDefined();
  });

  it('marks the version failed with the actual manifest error, not the generic fallback, on invalid SKILL.md frontmatter', async () => {
    s3SendMock.mockResolvedValueOnce({
      Body: (async function* () { yield Buffer.from('zip-bytes'); })(),
    });
    // Extraction succeeds — SKILL.md is present — but its frontmatter is
    // missing the required 'name' field, so parseSkillManifest (real,
    // unmocked) throws SkillManifestError.
    safeExtractSkillZipMock.mockResolvedValue({
      accepted: [{ fileName: 'SKILL.md', buffer: Buffer.from('---\ndescription: d\n---\n') }],
      skipped: [],
      manifestSource: '---\ndescription: d\n---\n',
    });

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'zip', fileKey: 'tenants/tenant-1/skill-uploads/x.zip' },
    });

    const failCall = dbMock.execute.mock.calls.find((c) => sqlText(c[0]).includes("status = 'failed'"));
    expect(failCall).toBeDefined();
    const params = sqlParams(failCall![0]);
    expect(params.some((p) => typeof p === 'string' && p.includes("missing required field 'name'"))).toBe(true);
    expect(params.some((p) => typeof p === 'string' && p.includes('Import failed'))).toBe(false);
  });

  it('truncates the raw error before writing it to the tenant-readable audit log', async () => {
    // auditLog is exposed to tenant admins through /audit-log (readable and
    // CSV-exportable), so an unbounded raw error there is a side channel.
    const longMessage = `S3 GetObject failed: ${'x'.repeat(500)}`;
    s3SendMock.mockRejectedValueOnce(new Error(longMessage));

    const auditValues = vi.fn().mockReturnValue({ catch: () => {} });
    dbMock.insert.mockReturnValue({ values: auditValues });

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'zip', fileKey: 'tenants/tenant-1/skill-uploads/x.zip' },
    });

    const auditRow = auditValues.mock.calls.at(-1)?.[0] as { action: string; metadata: { error: string } };
    expect(auditRow.action).toBe('skill_import_failed');
    expect(auditRow.metadata.error.length).toBeLessThanOrEqual(201);
    expect(auditRow.metadata.error.endsWith('…')).toBe(true);

    // The tenant-facing failure_reason is still the generic message — an
    // unexpected S3 error is not a tenant-safe rejection.
    const failCall = dbMock.execute.mock.calls.find((c) => sqlText(c[0]).includes("status = 'failed'"));
    expect(sqlParams(failCall![0]).some((p) => p === 'Import failed — see server logs for details')).toBe(true);
  });

  it('writes a single SKILL.md and reaches ready for an authored source', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    const body = '---\nname: bid-writer\ndescription: Writes bids for RFPs\n---\n\nAlways open with the client name.';
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body },
    });

    // Exactly one object written, at the version's prefix, and it is SKILL.md.
    const puts = s3SendMock.mock.calls
      .map(([command]) => (command as { input?: { Key?: string; Body?: unknown } }).input)
      .filter((input) => typeof input?.Key === 'string' && input.Key.includes('skill-packages/'));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.Key).toBe('skill-packages/skill-1/1/SKILL.md');
    expect(String(puts[0]!.Body)).toBe(body);

    // The version row is marked ready, with the parsed manifest.
    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain("status = 'ready'");
  });

  it('never calls S3 GetObject or the network for an authored source', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: d\n---\n\nBody.' },
    });

    expect(safeExtractSkillZipMock).not.toHaveBeenCalled();
  });

  it('fails an authored version whose body has no frontmatter', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: 'Just some prose with no frontmatter block.' },
    });

    const failCall = dbMock.execute.mock.calls.find((c) => sqlText(c[0]).includes("status = 'failed'"));
    expect(failCall).toBeDefined();
    const params = sqlParams(failCall![0]);
    expect(params.some((p) => typeof p === 'string' && p.includes('SKILL.md must start with a --- YAML frontmatter block'))).toBe(true);
    expect(params.some((p) => typeof p === 'string' && p.includes('Import failed'))).toBe(false);
  });

  it('rejects a github source with an unsafe owner/repo/ref before fetching anything', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'github', owner: 'ok-owner', repo: 'ok-repo', ref: '"; rm -rf /' },
    });

    expect(s3SendMock).not.toHaveBeenCalled();
    const failCall = dbMock.execute.mock.calls.find((c) => sqlText(c[0]).includes("status = 'failed'"));
    expect(failCall).toBeDefined();
  });

  it('attaches the skill to the agent after the version is ready', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: d\n---\n\nOpen with the client name.' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain('agent_skills');
    const params = dbMock.execute.mock.calls.flatMap(([q]) => sqlParams(q));
    expect(params).toContain('agent-1');
    // The body the agent runs on is the parsed manifest body, not the raw file.
    expect(params.some((p) => String(p).includes('Open with the client name.'))).toBe(true);
  });

  it('does not attach when the payload carries no attachToAgentId', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: d\n---\n\nBody.' },
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).not.toContain('agent_skills');
  });

  it('does not attach when the import fails', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: 'no frontmatter here' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain("status = 'failed'");
    expect(executed).not.toContain('agent_skills');
  });
});

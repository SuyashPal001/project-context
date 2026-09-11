import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// The archived-name UPDATE's `install_id` scalar subselect and its EXISTS
// guard both query `skill_installs si`, so a whole-statement `.toContain` /
// `.toMatch` on a filter like `si.tenant_id` is satisfied by either copy —
// deleting the filter from just one of them, or collapsing the guard to an
// unscoped `EXISTS (SELECT 1 FROM skill_installs si)`, still passes such an
// assertion. These pull each subquery's own text out so each can be checked
// in isolation and neither can hide behind the other.
function extractExistsGuard(sql: string): string | undefined {
  return sql.match(/EXISTS\s*\(\s*(SELECT 1 FROM skill_installs si[\s\S]*?)\)\s*$/m)?.[1];
}
function extractInstallIdSubselect(sql: string): string | undefined {
  return sql.match(/install_id\s*=\s*\(\s*(SELECT si\.id FROM skill_installs si[\s\S]*?)\)/)?.[1];
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

  // A test-set mockImplementation on dbMock.execute survives vi.clearAllMocks()
  // (that clears call history, not implementations), so any test that
  // overrides it must not leak that override into tests that run after it.
  afterEach(() => {
    dbMock.execute.mockReset();
  });

  it('marks the version ready and bumps skills.latestVersion on a valid zip', async () => {
    s3SendMock.mockResolvedValueOnce({
      Body: (async function* () { yield Buffer.from('zip-bytes'); })(),
    });
    safeExtractSkillZipMock.mockResolvedValue({
      accepted: [{ fileName: 'SKILL.md', buffer: Buffer.from('---\nname: demo\ndescription: "Use when a sample skill description is needed for testing"\n---\n') }],
      skipped: [],
      manifestSource: '---\nname: demo\ndescription: "Use when a sample skill description is needed for testing"\n---\n',
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
      accepted: [{ fileName: 'SKILL.md', buffer: Buffer.from('---\ndescription: "Use when a sample skill description is needed for testing"\n---\n') }],
      skipped: [],
      manifestSource: '---\ndescription: "Use when a sample skill description is needed for testing"\n---\n',
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

    const body = '---\nname: bid-writer\ndescription: Use when writing bids for RFPs\n---\n\nAlways open with the client name.';
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
      source: { type: 'authored', body: '---\nname: n\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
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
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nOpen with the client name.' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain('agent_skills');
    const params = dbMock.execute.mock.calls.flatMap(([q]) => sqlParams(q));
    expect(params).toContain('agent-1');
    // The body the agent runs on is the parsed manifest body, not the raw file.
    expect(params.some((p) => String(p).includes('Open with the client name.'))).toBe(true);
  });

  // The cross-tenant hole this closes: agent_skills.agent_id and
  // agent_skills.tenant_id are two independent foreign keys, so the previous
  // INSERT — which took both values straight from the queue payload — would
  // happily write a row pairing this tenant with another tenant's agent. On
  // that agent's next turn, fetchAgentSkills composed the row into its owner's
  // system prompt. The agents join makes the pair unrepresentable.
  it('constrains the attach INSERT to an agent in the same tenant', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const insert = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes('INSERT INTO agent_skills'));
    expect(insert).toBeDefined();
    // The row's agent_id and tenant_id come from the agents row itself, not
    // from the two payload values, and the agent is filtered by tenant.
    expect(insert).toContain('FROM agents a');
    expect(insert).toMatch(/a\.tenant_id\s*=/);
    expect(insert).toContain('SELECT a.id, a.tenant_id');
  });

  it('writes zero rows and logs when the agent belongs to a different tenant', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The mismatch is refused inside the database by the join, so from here it
    // is indistinguishable from any other zero-row outcome: no row is written.
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('SELECT count(*)')) return [{ n: 0 }];
      if (text.includes('INSERT INTO agent_skills')) return { count: 0 };
      return undefined;
    });

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'attacker-tenant', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'victim-tenant-agent',
    });

    // The import itself still succeeds — a refused attach must never flip an
    // already-completed import to 'failed'.
    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain("status = 'ready'");
    expect(executed).not.toContain("status = 'failed'");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('attach affected 0 rows'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('agent not in tenant'));
    warnSpy.mockRestore();
  });

  it('does not attach when the payload carries no attachToAgentId', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
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

  it('does not attach when the agent already has the maximum attached skills, but the import still succeeds', async () => {
    // Simulate 8 already-attached skills (MAX_ATTACHED_SKILLS) so the cap
    // check trips on count alone, independent of composed-char cost.
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('SELECT count(*)')) return [{ n: 8 }];
      return undefined;
    });

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: new-skill\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    // The guard would pass identically if deleted unless this also proves
    // the INSERT never ran while the import itself still completed.
    expect(executed).toContain("status = 'ready'");
    expect(executed).not.toContain('INSERT INTO agent_skills');
  });

  it('logs when the attach insert affects zero rows (e.g. no active skill_installs row exists yet)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('SELECT count(*)')) return [{ n: 0 }];
      if (text.includes('INSERT INTO agent_skills')) return { count: 0 };
      return undefined;
    });

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('attach affected 0 rows'));
    warnSpy.mockRestore();
  });

  it('does not let an attach failure flip an already-successful import to failed', async () => {
    // A malformed attachToAgentId (not validated as a UUID upstream) or a
    // deleted/foreign agent id raises inside the attach's own SELECT/INSERT.
    // That must not land in the outer catch, which would overwrite the
    // version's already-committed 'ready' status with 'failed'.
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('SELECT count(*)')) throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
      return undefined;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { handleSkillImport } = await import('../handlers/skillImport');
    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: n\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'not-a-uuid',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain("status = 'ready'");
    expect(executed).not.toContain("status = 'failed'");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('attach failed'));
    errorSpy.mockRestore();
  });

  it("reactivates the agent's existing row for this install instead of inserting a second", async () => {
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      // Match the reactivation UPDATE specifically (its `ORDER BY (s2.status
      // = 'active')` tiebreak appears nowhere else), not the archived-name
      // UPDATE — both statements contain the literal text 'UPDATE agent_skills'.
      if (text.includes('ORDER BY (s2.status')) return [{ id: 'row-1' }];
      return undefined;
    });
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain('UPDATE agent_skills');
    expect(executed).not.toContain('INSERT INTO agent_skills');
  });

  it('inserts with ON CONFLICT on the active-install index when no row exists yet', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const insert = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes('INSERT INTO agent_skills'));
    expect(insert).toContain('ON CONFLICT (agent_id, install_id)');
    expect(insert).toContain("install_id IS NOT NULL AND status = 'active'");
    expect(insert).not.toContain('(agent_id, tenant_id, name, version)');
  });

  it("doesn't count the agent's 'default' row, a dead install's row, or this install toward the cap", async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const count = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes('SELECT count(*)'));
    // The sentinel is name='default' AND install_id IS NULL together — a
    // real skill manifest named "default" (which carries an install_id) must
    // not be excluded by a bare `s.name <> 'default'`.
    expect(count).toContain("NOT (s.name = 'default' AND s.install_id IS NULL)");
    expect(count).toContain('s.install_id IS DISTINCT FROM');
    // Dead (uninstalled) installs don't count against the cap: left-join
    // skill_installs, tenant-scoped, and exclude a row whose install isn't
    // active any more.
    expect(count).toContain('LEFT JOIN skill_installs si ON si.id = s.install_id AND si.tenant_id =');
    expect(count).toContain('(s.install_id IS NULL OR si.status = ');
  });

  it('has no character budget: a long skill still attaches', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: `---\nname: long-skill\ndescription: "Use when a sample skill description is needed for testing"\n---\n\n${'x'.repeat(30_000)}` },
      attachToAgentId: 'agent-1',
    });

    const executed = dbMock.execute.mock.calls.map(([q]) => sqlText(q)).join('\n');
    expect(executed).toContain('INSERT INTO agent_skills');
  });

  // Ruling (a) from Task 4's review: the reactivation UPDATE must never
  // rename the row, because the old (agent_id, tenant_id, name, version)
  // unique constraint still covers archived rows — renaming here could
  // collide permanently with an archived row that already holds that name.
  it('the reactivation UPDATE never assigns name', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const reactivateSql = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes('ORDER BY (s2.status'));
    expect(reactivateSql).toBeDefined();
    expect(reactivateSql).not.toMatch(/name\s*=/);
  });

  // Fix round 1, IMPORTANT 1: the same old (agent_id, tenant_id, name,
  // version) constraint means setting `version` on this UPDATE can also
  // collide permanently — an active v1 row for this install plus an
  // archived v2 row would make reactivating v1 to version=2 raise 23505 on
  // every retry. agent_skills.version is a dedupe tiebreak only.
  it('the reactivation UPDATE never assigns version', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const reactivateSql = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes('ORDER BY (s2.status'));
    expect(reactivateSql).toBeDefined();
    expect(reactivateSql).not.toMatch(/version\s*=/);
  });

  // Fix round 1, IMPORTANT 2: nothing previously proved the reactivation
  // UPDATE's tenant filters were load-bearing — deleting `a.tenant_id` from
  // its subselect still passed every test. Assert on the literal SQL text
  // (all three joins constrain by tenant) and on the actual bound value.
  it('the reactivation UPDATE constrains by tenant on the agent, the row itself, and the install', async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const reactivateCall = dbMock.execute.mock.calls
      .find(([q]) => sqlText(q).includes('ORDER BY (s2.status'));
    expect(reactivateCall).toBeDefined();
    const reactivateSql = sqlText(reactivateCall![0]);
    expect(reactivateSql).toMatch(/a\.tenant_id\s*=/);
    expect(reactivateSql).toMatch(/s2\.tenant_id\s*=/);
    expect(reactivateSql).toMatch(/si\.tenant_id\s*=/);
    expect(sqlParams(reactivateCall![0])).toContain('tenant-1');
  });

  // Ruling (b): when the reactivation UPDATE touches zero rows (no row for
  // this install yet), a second UPDATE reuses an ARCHIVED row that already
  // holds this exact name and version, before ever reaching the INSERT.
  // Minor 5: the reactivation UPDATE must run (and be found to touch zero
  // rows) strictly before the archived-name UPDATE — assert that ordering
  // by call index, not just presence.
  it('reuses an archived same-name-and-version row when the reactivation UPDATE returns no rows, and never inserts', async () => {
    dbMock.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes("status = 'archived'")) return [{ id: 'archived-row' }];
      return undefined;
    });
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const calls = dbMock.execute.mock.calls.map(([q]) => sqlText(q));
    const reactivateIdx = calls.findIndex((t) => t.includes('ORDER BY (s2.status'));
    const archivedIdx = calls.findIndex((t) => t.includes("status = 'archived'"));
    expect(reactivateIdx).toBeGreaterThanOrEqual(0);
    expect(archivedIdx).toBeGreaterThan(reactivateIdx);
    expect(calls.join('\n')).not.toContain('INSERT INTO agent_skills');
  });

  it("the archived-name UPDATE's SQL contains status = 'archived', both tenant constraints, and binds the tenant", async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const archivedCall = dbMock.execute.mock.calls
      .find(([q]) => sqlText(q).includes("status = 'archived'"));
    expect(archivedCall).toBeDefined();
    const archivedSql = sqlText(archivedCall![0]);
    expect(archivedSql).toContain("status = 'archived'");
    expect(archivedSql).toMatch(/a\.tenant_id\s*=/);
    expect(archivedSql).toMatch(/s2\.tenant_id\s*=/);
    expect(sqlParams(archivedCall![0])).toContain('tenant-1');
  });

  // Fix round 1, new problem found in review: a scalar install_id subselect
  // with no matching active skill_installs row evaluates to NULL, which
  // would silently revive the archived row as a phantom hand-authored skill
  // (status='active', install_id=NULL). This is reachable — the API can
  // enqueue the import before the skill_installs row commits. The EXISTS
  // guard makes the whole UPDATE match zero rows in that case instead.
  //
  // Fix round 2: `si.tenant_id` and `si.status = 'active'` each appear
  // *twice* in this statement — once in the `install_id` scalar subselect,
  // once in the EXISTS guard — so asserting on the whole statement's text
  // is satisfied even if one of the two copies is deleted, or the guard is
  // collapsed to an unscoped `EXISTS (SELECT 1 FROM skill_installs si)`.
  // That is a real cross-tenant hole: tenant B's active install of the same
  // public catalog skill_id would satisfy an unscoped guard while tenant
  // A's own install_id subselect is NULL, reviving A's archived row with
  // install_id NULL. `extractExistsGuard` and `extractInstallIdSubselect`
  // isolate each subquery's own text so neither can hide behind the other.
  it("the archived-name UPDATE's EXISTS guard, isolated from the rest of the statement, filters by skill, tenant, and active status", async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const archivedSql = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes("status = 'archived'"));
    expect(archivedSql).toBeDefined();
    const guard = extractExistsGuard(archivedSql!);
    expect(guard).toBeDefined();
    expect(guard).toContain('si.skill_id');
    expect(guard).toContain('si.tenant_id');
    expect(guard).toContain("si.status = 'active'");
  });

  it("the archived-name UPDATE's install_id subselect, isolated from the EXISTS guard, is itself tenant- and status-scoped", async () => {
    const { handleSkillImport } = await import('../handlers/skillImport');

    await handleSkillImport({
      tenantId: 'tenant-1', skillId: 'skill-1', skillVersionId: 'version-1', version: 1,
      source: { type: 'authored', body: '---\nname: bid-writer\ndescription: "Use when a sample skill description is needed for testing"\n---\n\nBody.' },
      attachToAgentId: 'agent-1',
    });

    const archivedSql = dbMock.execute.mock.calls
      .map(([q]) => sqlText(q))
      .find((t) => t.includes("status = 'archived'"));
    expect(archivedSql).toBeDefined();
    const subselect = extractInstallIdSubselect(archivedSql!);
    expect(subselect).toBeDefined();
    expect(subselect).toContain('si.tenant_id');
    expect(subselect).toContain("si.status = 'active'");
  });
});

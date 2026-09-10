/**
 * The code sub-agent spec ids, duplicated here rather than derived from
 * `listSpecs()` in sources.ts.
 *
 * usage.ts is imported by nearly the entire mastra/tools/routes tree (it's
 * where `getPool` lives). If usage.ts imported sources.ts directly, every one
 * of those files would transitively pull in pmAgent.ts, architectAgent.ts,
 * directorAgent.ts and producerAgent.ts — each of which constructs a real
 * `Agent` at import time (calling `getMastraMemory()`, `selectModel`, etc.).
 * That eager construction broke tests that partially mock `../mastra/memory.js`
 * without anticipating usage.ts now reaching that far (see
 * task-9-report.md). This module has no such imports, so pulling it into
 * usage.ts is inert.
 *
 * sources.ts asserts at boot (`assertMatchesCodeSpecIds`) that this list is
 * exactly the SPECS ids, so drift between the two fails loudly instead of
 * silently under- or over-granting capability.
 */
export const CODE_SPEC_IDS = ['pm', 'architect', 'director', 'producer'] as const

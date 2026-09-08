# Skill Content Quality Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both skill-creation paths (web modal Generate, in-chat `create_skill`) enforce the same content-quality bar from one shared constant, and an imported skill's frontmatter `description` must clear a real length floor, not just a non-empty check.

**Architecture:** Extract the bulleted content-quality rules currently living only inside `SKILL_SYSTEM_PROMPT` into a new exported constant, `SKILL_CONTENT_QUALITY_BAR`. Both `SKILL_SYSTEM_PROMPT` (web modal Generate path) and `SKILL_CREATION_CONTRACT` (in-chat `create_skill` path) interpolate that same constant, so a change to the bar automatically applies to both. Separately, `parseSkillManifest` gains a minimum-length check on `description`, alongside its existing (already-shipped) non-empty check.

**Tech Stack:** TypeScript, Vitest, plain string constants — no new dependencies, no schema change, no new route.

**Spec:** `docs/superpowers/specs/2026-09-08-skill-quality-bar-design.md`

## Global Constraints

- No new dependencies, no schema change, no new API route (per spec's Non-goals).
- `SKILL_CREATION_CONTRACT`'s existing authorship rule ("agent writes the file, never the user") stays as-is, unchanged, alongside the new shared quality-bar text — the two are different concerns and this plan only adds to the contract, never removes from it.
- The description-quality check must use the same error type (`SkillManifestError`) and the same throwing behavior as the existing presence check in `skillManifest.ts`, so nothing downstream needs to handle a new error shape.
- Every existing test in `generationPrompt.test.ts` and `skillManifest.test.ts` must still pass unmodified except where a task explicitly extends them.

---

### Task 1: Extract `SKILL_CONTENT_QUALITY_BAR` and wire it into `SKILL_SYSTEM_PROMPT`

**Files:**
- Modify: `apps/agent-orchestrator/src/skills/generationPrompt.ts`
- Test: `apps/agent-orchestrator/src/skills/__tests__/generationPrompt.test.ts`

**Interfaces:**
- Produces: `export const SKILL_CONTENT_QUALITY_BAR: string` — a template-literal string containing the content-quality rules (specifics-over-generalities, tables for numeric constraints, good/bad example pair, failure-mode list, output template, length ceiling, ban on "ask the user" as content). Later tasks (Task 2) import this exact name from this exact file.

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe('SKILL_SYSTEM_PROMPT', ...)` block in `apps/agent-orchestrator/src/skills/__tests__/generationPrompt.test.ts`:

```typescript
import { SKILL_SYSTEM_PROMPT, SKILL_CONTENT_QUALITY_BAR, buildSkillPrompt } from '../generationPrompt.js'

// ... inside describe('SKILL_SYSTEM_PROMPT', () => { ... }):

  it('includes the shared content-quality bar verbatim, not a duplicated copy', () => {
    expect(SKILL_SYSTEM_PROMPT).toContain(SKILL_CONTENT_QUALITY_BAR)
  })
```

(Update the existing `import { SKILL_SYSTEM_PROMPT, buildSkillPrompt } from '../generationPrompt.js'` line at the top of the file to also import `SKILL_CONTENT_QUALITY_BAR`, as shown above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/skills/__tests__/generationPrompt.test.ts`
Expected: FAIL — `SKILL_CONTENT_QUALITY_BAR` is not exported from `../generationPrompt.js` (a TypeScript/import error, or `undefined` if the test runner is lenient — either way, the new test does not pass).

- [ ] **Step 3: Extract the constant and rewire `SKILL_SYSTEM_PROMPT`**

Replace the full content of `apps/agent-orchestrator/src/skills/generationPrompt.ts` with:

```typescript
// The prompt is the whole quality bar for created skills, and it is also the
// only thing standing between a user's brief and a version row that fails on
// SKILL.md frontmatter two services away. Both concerns live here so they can
// be tested without a model call.

export interface SkillBrief {
  name: string
  description?: string
  brief: string
  previousDraft?: string
  feedback?: string
}

// Shared across both skill-creation paths: the web modal's Generate flow
// (SKILL_SYSTEM_PROMPT, below) and the in-chat create_skill flow
// (SKILL_CREATION_CONTRACT, in platformAgent.ts). Extracted so the two paths
// can never silently drift apart on what "good" skill content means — a
// change here reaches both.
export const SKILL_CONTENT_QUALITY_BAR = `- Lead with when the skill applies and when it does not.
- Give concrete steps, rules, and worked examples in the user's own domain vocabulary.
- Prefer specifics over generalities: exact phrasings, exact formats, exact thresholds, exact numbers. "Open with the client's name and the tender reference" beats "personalize the opening". If the brief is thin, do not pad with generic advice — pull in the real, well-known concrete standards of that domain (actual character limits, actual naming conventions, actual industry rules of thumb) rather than writing something that would apply to any task in any field.
- Where the domain has numeric constraints (limits, sizes, thresholds, formats), render them as a table, not prose.
- Include at least one concrete good-vs-bad example pair using realistic strings from the domain — not abstract descriptions of what makes something good.
- Include an explicit list of common mistakes or failure modes to avoid, and why each one fails.
- If the skill produces an artifact (a document, a message, a piece of copy, a config), include a literal output template or skeleton the agent fills in — not just a description of what the output should contain.
- State what to avoid, and why, where getting it wrong is likely.
- Keep it under roughly 400 lines. A skill an agent can hold in context beats an exhaustive one it skims.

Do not write steps whose content is "ask the user clarifying questions." A skill is consulted mid-task, not a conversation opener — the agent already has whatever context it has, and stopping to interview the user on every field defeats the point of having a skill. If a genuinely unknown, task-specific fact is required (a name, a number, a file that must exist), name that single fact plainly as a precondition near the top, not as a multi-step intake script.`

export const SKILL_SYSTEM_PROMPT = `You write SKILL.md files. A skill is a page in a manual that an AI agent reads before doing a task — it is not documentation for a human, and not marketing copy.

Output rules, all mandatory:

1. Output the file and nothing else. No code fences, no preamble, no closing remarks.
2. Begin with a YAML frontmatter block, delimited by a line containing exactly --- before and after it. The block must contain:
   name: a lowercase kebab-case identifier, 2-4 words
   description: one sentence, under 200 characters, saying when an agent should use this skill
3. After the closing ---, write the body in Markdown.

Write the body as instructions addressed to the agent that will follow them, not as advice addressed to a human:

${SKILL_CONTENT_QUALITY_BAR}

Never invent facts about the user's business, customers, or numbers. Where a specific fact the agent needs is unknown, say so as a precondition rather than filling it in or building the whole skill around asking for it.`

export function buildSkillPrompt(input: SkillBrief): string {
  const { name, description, brief, previousDraft, feedback } = input

  const sections = [
    `Skill name the user gave: ${name}`,
    description ? `One-line description the user gave: ${description}` : null,
    `What the user wants this skill to do:\n${brief}`,
  ].filter(Boolean)

  if (previousDraft) {
    sections.push(
      `Here is the previous draft you produced. Rewrite it in full — output the complete new file, not a diff or a description of changes.\n\n${previousDraft}`,
    )
    sections.push(
      feedback
        ? `What the user wants changed about that previous draft:\n${feedback}`
        : 'The user asked for another attempt without saying what was wrong. Produce a materially different draft rather than a reworded copy of the previous one.',
    )
  }

  return sections.join('\n\n')
}
```

Note: this is a pure refactor of `SKILL_SYSTEM_PROMPT`'s text — the rendered string is byte-for-byte identical to before (the bulleted content that used to be inlined now arrives via `${SKILL_CONTENT_QUALITY_BAR}` interpolation, at the same position). `buildSkillPrompt` is untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/skills/__tests__/generationPrompt.test.ts`
Expected: PASS — all existing tests (frontmatter contract, "for an agent not a human", `buildSkillPrompt` tests) plus the new quality-bar test.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/skills/generationPrompt.ts apps/agent-orchestrator/src/skills/__tests__/generationPrompt.test.ts
git commit -m "refactor(skills): extract SKILL_CONTENT_QUALITY_BAR from SKILL_SYSTEM_PROMPT"
```

---

### Task 2: Wire `SKILL_CONTENT_QUALITY_BAR` into `SKILL_CREATION_CONTRACT`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/skillCreationContract.test.ts` (new file)

**Interfaces:**
- Consumes: `SKILL_CONTENT_QUALITY_BAR` from `../../skills/generationPrompt.js` (Task 1).
- Produces: `export const SKILL_CREATION_CONTRACT: string`, moved from a local variable inside the `instructions` async function to module scope, so it is importable by tests and by any future consumer. Its usage inside the `instructions` function (`return composed + CLARIFICATION_CONTRACT + ... + SKILL_CREATION_CONTRACT`) is unchanged — it still resolves via the closure, now reading a module-level constant instead of a per-call local one.

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/agents/__tests__/skillCreationContract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { SKILL_CREATION_CONTRACT } from '../platformAgent.js'
import { SKILL_CONTENT_QUALITY_BAR } from '../../../skills/generationPrompt.js'

describe('SKILL_CREATION_CONTRACT', () => {
  it('still tells the agent to write the file itself, never the user', () => {
    expect(SKILL_CREATION_CONTRACT).toContain('YOU write the complete SKILL.md body yourself')
    expect(SKILL_CREATION_CONTRACT).toContain('NEVER call ask_clarifying_questions to ask the user to write or paste')
  })

  it('includes the same content-quality bar the Generate path uses', () => {
    expect(SKILL_CREATION_CONTRACT).toContain(SKILL_CONTENT_QUALITY_BAR)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/skillCreationContract.test.ts`
Expected: FAIL — `SKILL_CREATION_CONTRACT` is not exported from `platformAgent.ts` (it's currently a local `const` declared inside the `instructions` function body, not a module-level export).

- [ ] **Step 3: Move `SKILL_CREATION_CONTRACT` to module scope and append the shared bar**

In `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`:

First, add the import near the top of the file, alongside the existing relative imports (e.g. near `import { platformModel, liteModel, privateModel } from '../model.js'`):

```typescript
import { SKILL_CONTENT_QUALITY_BAR } from '../../skills/generationPrompt.js'
```

Then, find the existing local declaration inside the `instructions` async function:

```typescript
    const SKILL_CREATION_CONTRACT = `\n\n## Skill creation — required behaviour
When the user asks you to save something as a skill, YOU write the complete SKILL.md body yourself from the conversation so far — frontmatter, instructions, everything — and call create_skill with it. NEVER call ask_clarifying_questions to ask the user to write or paste the skill's markdown/YAML content themselves; that is your job, not theirs. It is fine to ask a short clarifying question about scope or naming, but never to ask them to produce the file.`
```

Delete that local declaration entirely, and instead add this as a module-level export, placed above `export const platformAgent = new Agent({...})` (i.e., outside and before the `Agent` constructor call, at the same nesting level as the `platformAgent` export itself):

```typescript
// Shared with the web modal's Generate path (SKILL_SYSTEM_PROMPT in
// generationPrompt.ts) via SKILL_CONTENT_QUALITY_BAR — a skill Olmo writes
// unprompted in chat is held to the same content bar as one generated
// through the dashboard modal. The authorship rule below (agent writes the
// file, never the user) is a separate concern from content quality and
// stays inline.
export const SKILL_CREATION_CONTRACT = `\n\n## Skill creation — required behaviour
When the user asks you to save something as a skill, YOU write the complete SKILL.md body yourself from the conversation so far — frontmatter, instructions, everything — and call create_skill with it. NEVER call ask_clarifying_questions to ask the user to write or paste the skill's markdown/YAML content themselves; that is your job, not theirs. It is fine to ask a short clarifying question about scope or naming, but never to ask them to produce the file.

## Skill content quality — required behaviour
${SKILL_CONTENT_QUALITY_BAR}`
```

Leave the `return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT` line inside `instructions` completely unchanged — `SKILL_CREATION_CONTRACT` now resolves to the module-level export via the same closure lookup JavaScript already does for any outer-scope reference, no code change needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/skillCreationContract.test.ts`
Expected: PASS

Then run the full orchestrator test suite to confirm nothing else broke from moving the constant out of the closure:

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agent.test.ts src/mastra/agents/__tests__/`
Expected: PASS (all existing tests, e.g. `agent.test.ts`'s persona/skill-parity tests, `modelSelection.test.ts`, `delegateVariants.test.ts`, `olmoDelegates.test.ts`, plus the new file)

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts apps/agent-orchestrator/src/mastra/agents/__tests__/skillCreationContract.test.ts
git commit -m "feat(agents): share content-quality bar between Generate and in-chat skill creation"
```

---

### Task 3: Add a description quality floor to `parseSkillManifest`

**Files:**
- Modify: `products/agent-platform/packages/worker-handlers/lib/skillManifest.ts`
- Test: `products/agent-platform/packages/worker-handlers/__tests__/skillManifest.test.ts`

**Interfaces:**
- Consumes: nothing new — this task only extends the existing `parseSkillManifest(skillMdContent: string): SkillManifest` function, same signature, same `SkillManifestError` throw type.
- Produces: `parseSkillManifest` now also rejects a `description` that is present but shorter than a minimum length, in addition to its existing (unchanged) rejection of a missing/empty `description`.

- [ ] **Step 1: Write the failing tests**

Add these test cases to the existing `describe('parseSkillManifest', ...)` block in `products/agent-platform/packages/worker-handlers/__tests__/skillManifest.test.ts`:

```typescript
  it('rejects a description that is present but too short to be useful', () => {
    const md = `---\nname: too-thin\ndescription: a skill\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/too short/i);
  });

  it('rejects a description exactly one character under the floor', () => {
    // 19 characters — one under the 20-character floor this task introduces.
    const md = `---\nname: one-under\ndescription: "0123456789012345678"\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/too short/i);
  });

  it('accepts a description right at the minimum length', () => {
    // Exactly 20 characters — the floor this task introduces.
    const md = `---\nname: right-at-floor\ndescription: "01234567890123456789"\n---\nbody`;
    const manifest = parseSkillManifest(md);
    expect(manifest.description).toBe('01234567890123456789');
  });

  it('still distinguishes a missing description from a too-short one', () => {
    const md = `---\nname: no-description\n---\nbody`;
    expect(() => parseSkillManifest(md)).toThrow(/missing required field/i);
  });
```

- [ ] **Step 2: Run tests to verify the new failing one fails**

Run: `cd products/agent-platform/packages/worker-handlers && npx vitest run __tests__/skillManifest.test.ts`
Expected: The two "too short" tests (7-character `"a skill"` and the 19-character boundary case) FAIL — today, any non-empty string passes the existing check, so neither throws. The "right at the minimum length" and "still distinguishes a missing description" tests already PASS today (a 20-char description already clears the existing non-empty check, and the existing missing-description behavior is unchanged) — they're here as boundary/regression guards once the floor is added in Step 3.

- [ ] **Step 3: Add the length floor**

In `products/agent-platform/packages/worker-handlers/lib/skillManifest.ts`, add a constant near the top of the file (after the `FRONTMATTER_RE` declaration) and extend the existing description check inside `parseSkillManifest`:

```typescript
// A non-empty description like "a skill" or "helper" passes a presence check
// but gives an agent's skill_search nothing to match a task against. This is
// the cheapest, least-ambiguous floor: a real "when to use this" sentence is
// essentially never under 20 characters. A stronger content check (does it
// actually describe a *when*, not just a *what*) is a nice-to-have that adds
// LLM-judgment complexity to what is otherwise pure string parsing — start
// here, revisit only if thin-but-long descriptions turn out to be a real
// problem in practice.
const MIN_DESCRIPTION_LENGTH = 20;
```

Then replace the existing description check:

```typescript
  if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
    throw new SkillManifestError("SKILL.md frontmatter is missing required field 'description'");
  }
```

with:

```typescript
  if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
    throw new SkillManifestError("SKILL.md frontmatter is missing required field 'description'");
  }
  if (manifest.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    throw new SkillManifestError(
      `SKILL.md frontmatter 'description' is too short to be useful (${manifest.description.trim().length} chars, minimum ${MIN_DESCRIPTION_LENGTH}) — write a real sentence saying when an agent should use this skill`,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd products/agent-platform/packages/worker-handlers && npx vitest run __tests__/skillManifest.test.ts`
Expected: PASS — all existing tests (including the existing "rejects frontmatter missing description" test, which uses no `description` key at all and is unaffected by the new length check) plus all four new tests.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/worker-handlers/lib/skillManifest.ts products/agent-platform/packages/worker-handlers/__tests__/skillManifest.test.ts
git commit -m "feat(skills): reject imports whose frontmatter description is too thin to search on"
```

---

## Post-plan verification

After all three tasks are committed, run the full test suites for both affected packages to confirm no cross-task regressions:

```bash
cd apps/agent-orchestrator && npx vitest run
cd products/agent-platform/packages/worker-handlers && npx vitest run
```

Both should report all tests passing, with no changes needed beyond what the three tasks above already made.

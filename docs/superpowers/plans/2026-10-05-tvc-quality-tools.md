# TVC Quality in the Tools (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every defect found in the 2026-10-05 hand-built test ads into tool code (joins, narrow high-resolution checks, plan rules, video anchoring, text placement), so that making the user-approved Bubbli v5 ad *through the product* catches or prevents each one without relying on prompt text.

**Architecture:**
- **`tvcChecks.ts` (new library):** narrow, one-question-per-frame checks on gemini-2.5-pro through the gateway, with an injectable `AskFn` and frame sampler so every check is unit-testable.
- **Callers of the library:** `check_clip` (new optional inputs), a new `check_still` tool, and face-aware placement in `overlay_text` and `composite_end_card`.
- **Plan and other tools:**
  - `tvcPlan.ts` gains shot fields and rules (angle, endState, continuesFrom, extras, reference product type and cut times), plus a code-built `shotPromptFor` that the slices return.
  - `assemble_clips` keeps the source frame rate, verifies its own output length and softens audio at cuts.
  - `generate_video` anchors product shots with Omni `reference_to_video`.
  - The gateway maps content blocks to a plain refusal.

**Tech Stack:** TypeScript, Mastra `createTool`, zod, vitest, ffmpeg/ffprobe via `execFile`, the inference gateway's OpenAI-style `/v1/chat/completions`, Gemini Omni through the gateway's `/v1/video/generations`.

**Spec:** `docs/superpowers/specs/2026-10-05-tvc-quality-tools-design.md` (Part A only; Part B, the jingle, is out of scope).

## Global Constraints

- **Additive prompt changes only:** never delete or reword a shipped line in any skill or agent prompt. Add lines that say they supersede, and edit only the TVC files (`tvc-ad.md`, `tvc-ad/director.md`).
- **No automatic paid clip redo:** a failed clip is returned to the user. A failed **still** gets exactly one automatic retry, inside the already-approved plan cost.
- **Checks are free to the user:** every Pro call's tokens are logged with `persistCost` (`agentId: 'check-clip'`, `workflowId: 'media-understanding'`).
- **Unreachable check:** if a Pro check call fails, retry it once with the same inputs. Then report the clip or still as unchecked (`CHECK_UNAVAILABLE`), never as a pass.
- **Narrow and high-res:** each check is a short question per frame, on full-resolution frames (no scaling), with model `gemini-2.5-pro`. Never one big multi-part question on small frames.
- **Paid tools:** charge first and refund on every failure path. Any key built from a tool-call id goes through `stableToolCallId()`.
- **Existing callers unchanged:** `check_clip` called without the new inputs (talking-head, UGC) must send byte-identical prompts and make no new model calls.
- **Shot rules:** at most 12 shots (`assemble_clips` max raised to 12). Shots are 1.2–2.5s by default, ≥ 0.6s when the plan follows a reference's cut times, ≥ 0.3s with `flashCut`. The packshot is 2–4s.
- **Failures Director can act on:** every new failure is a plain-words reason: `DURATION_MISMATCH`, `CONTENT_BLOCKED`, `STILL_NOT_CHECKED`, `CONTINUING_SHOT_HAS_NO_STILL`, `REFERENCE_PRODUCT_MISMATCH`, `LEAD_CLONED`, `ACTION_NOT_COMPLETED`, `CHECK_UNAVAILABLE`.
- **Commits:** every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Where work happens:** in the worktree `.claude/worktrees/tvc-ad` on branch `tvc-ad-spec`. Never `git stash`, never push.

## Review Focus

1. **Existing presenter callers of `check_clip`** (talking-head, UGC, no new inputs) must behave exactly as before: same prompt, no Pro calls. Pinned in Task 3 ("legacy call makes no narrow checks").
2. **A Pro check call that errors twice** must yield `CHECK_UNAVAILABLE`, never `passed: true`. Pinned in Task 2 (gatewayAsk retry test) and Task 3 (tool returns refused).
3. **A plan saved before this change** (locations as plain strings, no `angle`, no `endState`) must still validate and slice. Pinned in Task 5 and Task 6 (legacy plan test).
4. **An unparseable `ffprobe` result in `assemble_clips`** must fall back to 30fps and skip the length check, never refuse a valid join. Pinned in Task 1 ("probe garbage falls back").
5. **A face-detection failure in `overlay_text` or `composite_end_card`** must keep the requested placement, never fail the overlay. Pinned in Task 10.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts` (create) | `AskFn`, `gatewayAsk`, frame sampling helpers, every narrow check (product, glitch, extras, lead clone, lead face, action/end state/physics), `runNarrowClipChecks`, `runStillChecks`, `trimStartFor`, face boxes and placement choice |
| `apps/agent-orchestrator/src/mastra/tools/tvcChecks.test.ts` (create) | Unit tests with a fake `AskFn` |
| `apps/agent-orchestrator/src/mastra/tools/checkClip.ts` (modify) | New optional inputs, re-check guard keys, wiring to `runNarrowClipChecks`, export `fetchBase64` |
| `apps/agent-orchestrator/src/mastra/tools/checkStill.ts` (create) | `check_still` tool + passed-stills registry |
| `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts` (modify) | A1–A3, max 12 clips |
| `apps/agent-orchestrator/src/mastra/tools/assembleClips.realffmpeg.test.ts` (create) | Tagged real-ffmpeg join check |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts` (modify) | P1–P10 rules, schema fields, `shotPromptFor`, slice fields |
| `apps/agent-orchestrator/src/mastra/tools/planTvc.ts` (modify) | `stillChecked` dependency, refusals for unchecked stills and continuing shots |
| `apps/agent-orchestrator/src/mastra/tools/detectCuts.ts` (create) | Free `detect_cuts` tool |
| `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts` (modify) | `productFileId` on `animate_frame` → `reference_to_video` |
| `apps/inference-gateway/src/video.ts` (modify) | `CONTENT_BLOCKED` mapping |
| `apps/agent-orchestrator/src/mastra/tools/overlayText.ts`, `compositeEndCard.ts` (modify) | `avoidFaces` |
| `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (modify) | Register `check_still`, `detect_cuts` on both tool maps |
| `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`, `tvc-ad.md` (modify, additive) | Thin pointers to the tools |
| `apps/agent-orchestrator/test-fixtures/tvc/*` (create) | Regression clips and reference images |
| `apps/agent-orchestrator/src/mastra/tools/tvcChecks.regression.test.ts` (create) | Tagged real-model regression suite |

---

### Task 1: `assemble_clips` keeps the frame rate, verifies its length, softens cuts (A1–A3)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/assembleClips.realffmpeg.test.ts`

**Interfaces:**
- Produces:
  - `export function chooseFrameRate(rates: number[]): number`
  - `export function parseRate(r: string | undefined): number`, which parses `"24/1"` to 24, or returns NaN
  - input `roomTone?: boolean`
  - `clipFileIds` max 12
  - output `fps?: number`
  - refusal `DURATION_MISMATCH`

- [ ] **Step 1: Write the failing tests** (append to `assembleClips.test.ts`, and change the existing "rejects a 9th clip id" test into "rejects a 13th clip id")

First change the existing test's array to 13 ids and its title:

```ts
  it('rejects a 13th clip id', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'],
      aspectRatio: '9:16',
    })
    expect(result.success).toBe(false)
  })
```

Then, because the tool now runs `ffprobe` before `ffmpeg`, add this helper near the top of the file (after `baseCtx`):

```ts
const ffmpegCall = () => execFile.mock.calls.find((c) => c[0] === 'ffmpeg')! as unknown as [string, string[]]
```

Replace every `execFile.mock.calls[0][1]` in the file with `ffmpegCall()[1]` (4 places).

Append:

```ts
import { chooseFrameRate, parseRate } from './assembleClips.js'

describe('frame rate (A1)', () => {
  it('parses ffprobe rates', () => {
    expect(parseRate('24/1')).toBe(24)
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseRate(undefined)).toBeNaN()
    expect(parseRate('0/0')).toBeNaN()
  })
  it('keeps a shared rate and never upsamples 24 to 30', () => {
    expect(chooseFrameRate([24, 24, 24])).toBe(24)
    expect(chooseFrameRate([24, 24, 30])).toBe(24)
    expect(chooseFrameRate([30, 30, 24])).toBe(30)
  })
  it('falls back to 30 when no rate could be read', () => {
    expect(chooseFrameRate([NaN, NaN])).toBe(30)
    expect(chooseFrameRate([])).toBe(30)
  })
})

describe('assembleClips probe, fades and length check (A1–A3)', () => {
  const probeJson = (fps: string, dur: string) => JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: fps, duration: dur }, { codec_type: 'audio', duration: dur }] })

  it('uses the clips own 24fps, resets timestamps and fades audio at every cut', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'a1', name: 'a.mp4', type: 'video/mp4', size: 8 })
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('format=duration')) return cb(null, { stdout: '4.000\n', stderr: '' })
      if (cmd === 'ffprobe') return cb(null, { stdout: probeJson('24/1', '2.000'), stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '16:9' } as never, baseCtx())

    const graph = ffmpegCall()[1][ffmpegCall()[1].indexOf('-filter_complex') + 1]
    expect(graph).toContain('fps=24')
    expect(graph).not.toContain('fps=30')
    expect(graph).toContain('setpts=PTS-STARTPTS')
    expect(graph).toContain('asetpts=PTS-STARTPTS')
    expect(graph).toContain('afade=t=in:d=0.04')
    expect(graph).toContain('afade=t=out:st=1.96:d=0.04')
    expect(result).toMatchObject({ fileId: 'a1', fps: 24 })
  })

  it('refuses DURATION_MISMATCH and refunds when the output length is off by more than 0.1s', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('format=duration')) return cb(null, { stdout: '5.20\n', stderr: '' })
      if (cmd === 'ffprobe') return cb(null, { stdout: probeJson('24/1', '2.000'), stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '16:9' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^DURATION_MISMATCH/) })
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refund' }))
  })

  it('probe garbage falls back to 30fps and skips the length check (never refuses a valid join)', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'a2', name: 'a.mp4', type: 'video/mp4', size: 8 })
    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '16:9' } as never, baseCtx())
    const graph = ffmpegCall()[1][ffmpegCall()[1].indexOf('-filter_complex') + 1]
    expect(graph).toContain('fps=30')
    expect(result).toMatchObject({ fileId: 'a2' })
  })

  it('lays a continuous room tone under the joined audio when roomTone is set', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'a3', name: 'a.mp4', type: 'video/mp4', size: 8 })
    await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, roomTone: true, aspectRatio: '16:9' } as never, baseCtx())
    const args = ffmpegCall()[1]
    expect(args.join(' ')).toContain('anoisesrc=color=brown')
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('lowpass=f=700')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/assembleClips.test.ts`
Expected: FAIL. `chooseFrameRate`/`parseRate` are not exported, the 13th-clip test passes 12-max only after the change, and the graph still contains `fps=30`.

- [ ] **Step 3: Implement**

In `assembleClips.ts`:

1. Change `clipFileIds: z.array(z.string()).min(1).max(8)` to `.max(12)`. Add to `inputSchema`'s object, right after `audioFileId`:

```ts
  roomTone: z.boolean().optional().describe('With preserveAudio: lay one continuous, very quiet room tone under the joined audio so the sound does not jump at every cut.'),
```

Add `fps: z.number().optional(),` to `outputSchema`.

2. Add above `buildTransitionsFilterComplex`:

```ts
// Omni renders at 24fps; forcing 30 duplicated frames and juddered every TVC
// (2026-10-05 test ads). Keep the clips' own rate; never upsample 24 to 30.
export function parseRate(r: string | undefined): number {
  if (!r) return NaN
  const [n, d] = r.split('/').map(Number)
  const v = d ? n / d : n
  return Number.isFinite(v) && v > 0 ? v : NaN
}

export function chooseFrameRate(rates: number[]): number {
  const known = rates.filter((r) => Number.isFinite(r) && r > 0).map((r) => Math.round(r * 100) / 100)
  if (known.length === 0) return 30
  const counts = new Map<number, number>()
  for (const r of known) counts.set(r, (counts.get(r) ?? 0) + 1)
  let best = known[0]
  for (const [r, c] of counts) if (c > (counts.get(best) ?? 0) || (c === counts.get(best) && r < best)) best = r
  return best
}

interface ClipProbe { fps: number; duration: number }
async function probeClip(path: string): Promise<ClipProbe> {
  try {
    const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,duration', '-of', 'json', path], { timeout: FFMPEG_TIMEOUT_MS })
    const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; r_frame_rate?: string; duration?: string }> }
    const v = probe.streams?.find((s) => s.codec_type === 'video')
    return { fps: parseRate(v?.r_frame_rate), duration: parseFloat(v?.duration ?? '') }
  } catch {
    return { fps: NaN, duration: NaN }
  }
}
```

3. In `execute`, right after the clips (and narration) are downloaded and **before** the charge block, add:

```ts
    const probes: ClipProbe[] = []
    for (const p of localPaths) probes.push(await probeClip(p))
    const fps = chooseFrameRate(probes.map((p) => p.fps))
```

4. Replace the `videoFilterParts` line with:

```ts
      const videoFilterParts = localPaths.map((_, i) =>
        `[${i}:v]setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      )
```

5. In the `else if (preserveAudio)` branch, replace its `audioFilterParts` with the faded version, and handle room tone:

```ts
        // 40ms fades at every cut: each clip has its own room tone, and a
        // hard audio edge made every cut jump (2026-10-05 test ads).
        const audioFilterParts = localPaths.map((_, i) => {
          const d = probes[i].duration
          const fadeOut = Number.isFinite(d) && d > 0.1 ? `,afade=t=out:st=${Math.round((d - 0.04) * 100) / 100}:d=0.04` : ''
          return `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=0.04${fadeOut}[a${i}]`
        })
        const concatInputs = localPaths.map((_, i) => `[v${i}][a${i}]`).join('')
        const joinedLabel = roomTone ? 'joined' : 'outa'
        filterComplex = `${videoFilterParts.join('; ')}; ${audioFilterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=1[outv][${joinedLabel}]`
        if (roomTone) {
          const roomIdx = localPaths.length + (audioPath ? 1 : 0)
          filterComplex += `; [${roomIdx}:a]lowpass=f=700,volume=0.5,aformat=sample_fmts=fltp:channel_layouts=stereo[room]; [joined][room]amix=inputs=2:duration=first:normalize=0[outa]`
        }
```

Destructure `roomTone` from `inputData` alongside the other fields.

6. In the args builder, right after `if (audioPath) args.push('-i', audioPath)`, add:

```ts
      if (preserveAudio && roomTone) {
        const total = probes.reduce((s, p) => s + (Number.isFinite(p.duration) ? p.duration : 0), 0) || 60
        args.push('-f', 'lavfi', '-t', String(Math.ceil(total) + 1), '-i', 'anoisesrc=color=brown:amplitude=0.02:sample_rate=48000')
      }
```

7. After `await execFile('ffmpeg', args, ...)` succeeds (still inside the `try`), add the length check for plain concats:

```ts
      // Joining many short pieces once produced 17.9s for 14.8s of pieces
      // (2026-10-05). Verify the output instead of trusting the exit code.
      const expected = probes.reduce((s, p) => s + p.duration, 0)
      if (!transitions?.length && targetDurationSeconds === undefined && Number.isFinite(expected) && expected > 0) {
        const { stdout: outDur } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputPath], { timeout: FFMPEG_TIMEOUT_MS })
        const actual = parseFloat(outDur.trim())
        if (Number.isFinite(actual) && Math.abs(actual - expected) > 0.1) {
          throw Object.assign(new Error(`DURATION_MISMATCH: the joined video is ${actual.toFixed(2)}s but its pieces add up to ${expected.toFixed(2)}s`), { durationMismatch: true })
        }
      }
```

In the `catch`, before the `INVALID_TRANSITION_OVERLAP` check, add:

```ts
      if ((err as { durationMismatch?: boolean }).durationMismatch) {
        return { refused: true, refusalReason: message, jobId }
      }
```

(`message` is already defined there as `(err as Error).message ?? ''`. Move its declaration above this new check if needed.)

8. Add `fps,` to the successful return object.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/assembleClips.test.ts`
Expected: PASS, all old and new tests.

- [ ] **Step 5: Add the real-ffmpeg join check**

Create `apps/agent-orchestrator/src/mastra/tools/assembleClips.realffmpeg.test.ts`:

```ts
// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const uploaded: Buffer[] = []
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }) }))
const dir = mkdtempSync(join(tmpdir(), 'asm-real-'))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => id),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => ({ filePath: join(dir, `${id}.mp4`) })),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { assembleClips } from './assembleClips.js'

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('assemble_clips against real ffmpeg', () => {
  it('joins four 24fps clips at 24fps with the exact summed length', async () => {
    const lens = [1.5, 0.9, 2.2, 3.1]
    lens.forEach((d, i) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 100}:duration=${d}`, '-shortest', '-c:v', 'libx264', '-c:a', 'aac', join(dir, `c${i}.mp4`)]))
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
    const result = await assembleClips.execute!({ clipFileIds: ['c0', 'c1', 'c2', 'c3'], preserveAudio: true, aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: 'x' } } as never)
    expect(result).toMatchObject({ fileId: 'out', fps: 24 })
    const out = join(dir, 'joined.mp4'); writeFileSync(out, uploaded[0])
    const rate = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', out]).toString().trim()
    const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())
    expect(rate).toBe('24/1')
    expect(Math.abs(dur - lens.reduce((a, b) => a + b, 0))).toBeLessThanOrEqual(0.1)
  }, 120_000)
})
```

Run: `RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/assembleClips.realffmpeg.test.ts`
Expected: PASS. Without the env var, the suite is skipped.

- [ ] **Step 6: Full suite, type-check, commit**

Run: `pnpm --filter agent-orchestrator test && pnpm --filter agent-orchestrator type-check`
Expected: all pass. (`tvcPlan.test.ts` still says "at most 8" until Task 5; the 8-shot rule is unchanged by this task.)

```bash
git add apps/agent-orchestrator/src/mastra/tools/assembleClips.ts apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts apps/agent-orchestrator/src/mastra/tools/assembleClips.realffmpeg.test.ts
git commit -m "feat(orchestrator): assemble_clips keeps the clips' frame rate, checks its length, softens cuts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `tvcChecks.ts`, the narrow check library

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcChecks.test.ts`

**Interfaces:**
- Produces (all exported):
  - **Types:** `Img`, `AskPart`, `AskFn = (parts: AskPart[]) => Promise<Record<string, unknown>>`, `ProductScale`, `Box`.
  - **Constants:** `PRO_CHECK_MODEL = 'gemini-2.5-pro'`; question texts `GLITCH_QUESTION`, `EXTRAS_QUESTION`, `CLONE_QUESTION`, `LEAD_FACE_QUESTION`, `PHYSICS_QUESTION`, `REVERSAL_QUESTION`, `FACE_BOX_QUESTION`, `TEXT_BANDS`.
  - **Errors:** `class CheckUnavailableError extends Error`.
  - **Gateway and frames:**
    - `gatewayAsk(tenantId: string, fetchImpl?: typeof fetch): AskFn`
    - `parseJsonObject(raw: string): Record<string, unknown> | null`
    - `evenTimes(duration: number, count: number): number[]`, `lastTimes(duration: number): number[]`
    - `sampleFrames(clipPath: string, times: number[], workDir: string): Promise<Img[]>`
  - **Question builders:** `productQuestion(scale: ProductScale, expectedState?: string): string`, `actionLocateQuestion(action: string): string`, `endStateQuestion(endState: string): string`.
  - **Checks:**
    - `checkProduct(ask, product: Img, frames: Img[], opts: { scale: ProductScale; expectedState?: string; mustBeVisible: boolean }): Promise<{ passed: boolean; reason: string; allVisible: boolean }>`
    - `checkGlitches(ask, frames: Img[]): Promise<{ passed: boolean; reason: string }>`
    - `checkExtras(ask, frames: Img[]): Promise<{ passed: boolean; reason: string }>`
    - `checkLeadClone(ask, lead: Img, frames: Img[]): Promise<{ passed: boolean; reason: string }>`
    - `checkLeadFace(ask, lead: Img, frame: Img): Promise<{ passed: boolean; reason: string }>`
    - `checkAction(ask, frames: { t: number; img: Img }[], last: Img[], action: string, endState?: string): Promise<{ passed: boolean; actionTime: number | null; endStateTrue: boolean; reversed: boolean; reason: string }>`
  - **Combined runners:**
    - `trimStartFor(actionTime: number | null, durationSeconds: number, clipLength: number): number`
    - `interface NarrowClipInputs`, `interface NarrowClipResult`, `runNarrowClipChecks(ask, sample, input): Promise<NarrowClipResult>`
    - `interface StillInputs`, `runStillChecks(ask, still: Img, input: StillInputs): Promise<{ passed: boolean; reasons: string[] }>`
  - **Placement:** `faceBoxes(ask, frame: Img): Promise<Box[]>`, `chooseTextPosition(faces: Box[], preferred: 'top' | 'center' | 'bottom'): { position: 'top' | 'center' | 'bottom'; shrink: boolean }`, `chooseCardColumn(faces: Box[]): 'center' | 'left' | 'right'`.

- [ ] **Step 1: Write the failing tests**

Create `apps/agent-orchestrator/src/mastra/tools/tvcChecks.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
import {
  type AskFn, type AskPart, type Img, CheckUnavailableError, gatewayAsk, parseJsonObject, evenTimes, lastTimes,
  productQuestion, checkProduct, checkGlitches, checkExtras, checkLeadClone, checkLeadFace, checkAction, trimStartFor,
  runNarrowClipChecks, runStillChecks, chooseTextPosition, chooseCardColumn, faceBoxes, PRO_CHECK_MODEL,
} from './tvcChecks.js'

const img = (n: string): Img => ({ data: n, mime: 'image/jpeg' })
const lastText = (parts: AskPart[]) => (parts[parts.length - 1] as { text: string }).text
// A fake model: answers by which question it was asked.
function fakeAsk(answer: (q: string, parts: AskPart[]) => Record<string, unknown>): AskFn & { calls: AskPart[][] } {
  const calls: AskPart[][] = []
  const fn = (async (parts: AskPart[]) => { calls.push(parts); return answer(lastText(parts), parts) }) as AskFn & { calls: AskPart[][] }
  fn.calls = calls
  return fn
}

describe('gatewayAsk', () => {
  it('posts one Pro question with the frames as data URIs and parses the JSON', async () => {
    let body: { model: string; messages: Array<{ content: Array<{ type: string }> }> } | null = null
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"visible":true}\n```' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    }) as unknown as typeof fetch
    const v = await gatewayAsk('t1', fetchImpl)([{ image: img('AAA') }, { text: 'q' }])
    expect(v).toEqual({ visible: true })
    expect(body!.model).toBe(PRO_CHECK_MODEL)
    expect(body!.messages[0].content.map((c) => c.type)).toEqual(['image_url', 'text'])
  })
  it('retries once and then throws CheckUnavailableError (never a pass)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    await expect(gatewayAsk('t1', fetchImpl)([{ text: 'q' }])).rejects.toBeInstanceOf(CheckUnavailableError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('parseJsonObject ignores arrays and junk', () => {
    expect(parseJsonObject('[1]')).toBeNull()
    expect(parseJsonObject('no json')).toBeNull()
    expect(parseJsonObject('x {"a":1} y')).toEqual({ a: 1 })
  })
})

describe('frame times', () => {
  it('spreads frames evenly and takes the last three near the end', () => {
    expect(evenTimes(3, 2)).toEqual([1, 2])
    expect(lastTimes(3)).toEqual([2.25, 2.64, 2.9])
  })
})

describe('product check (C1–C3)', () => {
  it('asks material, shape and cap for close shots, only colour and label for wide shots', () => {
    expect(productQuestion('close')).toMatch(/glass vs plastic/)
    expect(productQuestion('close')).toMatch(/cap or closure/)
    expect(productQuestion('wide')).not.toMatch(/glass vs plastic|shape/)
    expect(productQuestion('wide')).toMatch(/label colour/)
    expect(productQuestion('close', 'the bottle has no cap')).toMatch(/the bottle has no cap/)
  })
  it('fails when the product must be visible and one frame lacks it (the vanished bottle)', async () => {
    let i = 0
    const ask = fakeAsk(() => (i++ === 2 ? { visible: false, same: true } : { visible: true, same: true }))
    const r = await checkProduct(ask, img('P'), [img('1'), img('2'), img('3'), img('4'), img('5')], { scale: 'medium', mustBeVisible: true })
    expect(r.passed).toBe(false)
    expect(r.allVisible).toBe(false)
    expect(r.reason).toMatch(/not visible/)
    expect(ask.calls).toHaveLength(5)
  })
  it('fails a visible but different product with the model\'s reason', async () => {
    const ask = fakeAsk(() => ({ visible: true, same: false, why: 'plastic, not glass' }))
    const r = await checkProduct(ask, img('P'), [img('1')], { scale: 'close', mustBeVisible: true })
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/plastic, not glass/) })
  })
  it('passes a product that is not visible when visibility is not required', async () => {
    const ask = fakeAsk(() => ({ visible: false, same: true }))
    expect((await checkProduct(ask, img('P'), [img('1')], { scale: 'close', mustBeVisible: false })).passed).toBe(true)
  })
})

describe('glitches, extras, clone, lead face (C4–C6)', () => {
  it('fails any glitch item and names it', async () => {
    const ask = fakeAsk(() => ({ duplicate_object: true, stray_face: false, invented_text: false, cg_effect: false, flat_background: false, what: 'two vending machines' }))
    const r = await checkGlitches(ask, [img('1')])
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/two vending machines/) })
  })
  it('extras: a single still with nobody behind fails; clips fail only when 2+ frames are empty', async () => {
    expect((await checkExtras(fakeAsk(() => ({ extras: false })), [img('1')])).passed).toBe(false)
    let i = 0
    expect((await checkExtras(fakeAsk(() => ({ extras: i++ !== 0 })), [img('1'), img('2'), img('3')])).passed).toBe(true)
    let j = 0
    expect((await checkExtras(fakeAsk(() => ({ extras: j++ === 0 })), [img('1'), img('2'), img('3')])).passed).toBe(false)
  })
  it('clone: one lookalike in any frame fails with LEAD_CLONED and where it is', async () => {
    let i = 0
    const ask = fakeAsk(() => ({ others: i++ === 1 ? [{ where: 'left, girl with notebook', looks_like_lead: true }] : [{ where: 'boy', looks_like_lead: false }] }))
    const r = await checkLeadClone(ask, img('L'), [img('1'), img('2'), img('3')])
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/LEAD_CLONED.*left, girl with notebook/) })
  })
  it('lead face: fails when the lead is missing or a different face', async () => {
    expect((await checkLeadFace(fakeAsk(() => ({ lead_present: true, same_face: false, why: 'rounder face' })), img('L'), img('S'))).passed).toBe(false)
    expect((await checkLeadFace(fakeAsk(() => ({ lead_present: true, same_face: true })), img('L'), img('S'))).passed).toBe(true)
  })
})

describe('action, end state, physics, motion reversal (C7) and trim window (C8)', () => {
  const frames = [0.3, 0.7, 1.0].map((t, i) => ({ t, img: img(String(i)) }))
  it('fails ACTION_NOT_COMPLETED when the cap is still on at the end (the 2026-10-05 opener)', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: 1.34 } : q.includes('impossible') ? { impossible: true, what: 'cap flies but bottle stays capped' } : { holds: false, why: 'green cap still on' })
    const r = await checkAction(ask, frames, [img('a'), img('b'), img('c')], 'cap pops off on the opener', 'the bottle has no cap')
    expect(r.passed).toBe(false)
    expect(r.endStateTrue).toBe(false)
    expect(r.reason).toMatch(/ACTION_NOT_COMPLETED/)
    expect(r.reason).toMatch(/impossible/)
  })
  it('fails when the action never happens', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: null } : q.includes('impossible') ? { impossible: false } : { holds: true })
    const r = await checkAction(ask, frames, [], 'she spins all the way around once')
    expect(r).toMatchObject({ passed: false, actionTime: null })
  })
  it('fails a movement that reverses mid-way and names it (the v5 spin)', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: 1.2 } : q.includes('impossible') ? { impossible: false }
      : q.includes('reverse') ? { reversal: true, what: 'the spin turns back the other way halfway' } : { holds: true })
    const r = await checkAction(ask, frames, [], 'she spins all the way around in one direction, 360°')
    expect(r.passed).toBe(false)
    expect(r.reversed).toBe(true)
    expect(r.reason).toMatch(/Movement reverses mid-way: the spin turns back the other way halfway/)
  })
  it('passes a real pop with the bottle open at the end', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: 1.67 } : q.includes('impossible') ? { impossible: false } : { holds: true })
    const r = await checkAction(ask, frames, [img('a'), img('b'), img('c')], 'cap pops off', 'the bottle has no cap')
    expect(r).toMatchObject({ passed: true, actionTime: 1.67, endStateTrue: true, reversed: false })
  })
  it('centres the trim window on the action, clamped to the clip', () => {
    expect(trimStartFor(1.67, 0.88, 3)).toBe(1.32)
    expect(trimStartFor(0.1, 1, 3)).toBe(0)
    expect(trimStartFor(2.9, 1, 3)).toBe(2)
    expect(trimStartFor(null, 1, 3)).toBe(0.4)
  })
})

describe('runNarrowClipChecks / runStillChecks', () => {
  const sample = vi.fn(async (times: number[]) => times.map((t) => img(`f${t}`)))
  it('runs only the checks whose inputs are given, and reports a trim window', async () => {
    const ask = fakeAsk((q) => q.includes('duplicate_object') ? { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false }
      : q.includes('at which') ? { action_time: 1.5 } : q.includes('impossible') ? { impossible: false } : { holds: true })
    const r = await runNarrowClipChecks(ask, sample, { duration: 3, action: 'cap pops off', endState: 'no cap', shotDurationSeconds: 0.88 })
    expect(r.passed).toBe(true)
    expect(r.trimStartSeconds).toBe(1.15)
    expect(r.productVisible).toBeUndefined()
  })
  it('a still with a cloned lead fails', async () => {
    const ask = fakeAsk((q) => q.includes('duplicate_object') ? { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false }
      : q.includes('OTHER person') ? { others: [{ where: 'behind her', looks_like_lead: true }] } : { extras: true })
    const r = await runStillChecks(ask, img('S'), { lead: img('L'), expectExtras: true })
    expect(r.passed).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/LEAD_CLONED/)
  })
})

describe('face-aware placement (O1)', () => {
  it('moves text off a face and shrinks to top when every band has a face', () => {
    expect(chooseTextPosition([{ x0: 0.4, y0: 0.05, x1: 0.6, y1: 0.3 }], 'top').position).toBe('center')
    expect(chooseTextPosition([{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }], 'center').position).toBe('top')
    expect(chooseTextPosition([{ x0: 0, y0: 0, x1: 1, y1: 1 }], 'center')).toEqual({ position: 'top', shrink: true })
    expect(chooseTextPosition([], 'bottom')).toEqual({ position: 'bottom', shrink: false })
  })
  it('puts the end card in a third with no face', () => {
    expect(chooseCardColumn([])).toBe('center')
    expect(chooseCardColumn([{ x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.5 }])).toBe('right')
    expect(chooseCardColumn([{ x0: 0.4, y0: 0, x1: 1, y1: 1 }])).toBe('left')
  })
  it('faceBoxes drops malformed boxes', async () => {
    const ask = fakeAsk(() => ({ faces: [{ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, { x0: 'a' }] }))
    expect(await faceBoxes(ask, img('F'))).toEqual([{ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcChecks.test.ts`
Expected: FAIL, "Cannot find module './tvcChecks.js'".

- [ ] **Step 3: Implement**

Create `apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts`:

```ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { persistCost } from '../cost.js'

// Narrow, high-resolution checks for the TVC ad (spec 2026-10-05-tvc-quality-
// tools-design.md §2 "Check design"). One short question per full-resolution
// frame on gemini-2.5-pro. A broad checker (small frames, many questions at
// once) passed a clip whose cap stayed on and missed a cloned face; the narrow
// questions caught both. Free to the user; tokens are logged with persistCost.
const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
export const PRO_CHECK_MODEL = 'gemini-2.5-pro'
const ASK_TIMEOUT_MS = 120_000
const r2 = (x: number) => Math.round(x * 100) / 100

export interface Img { data: string; mime: string }
export type AskPart = { text: string } | { image: Img }
export type AskFn = (parts: AskPart[]) => Promise<Record<string, unknown>>
export type ProductScale = 'close' | 'medium' | 'wide'
export interface Box { x0: number; y0: number; x1: number; y1: number }

export class CheckUnavailableError extends Error {}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const v = JSON.parse(raw.slice(s, e + 1)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The gateway's chat endpoint on the Pro check model. Retries once; then
 *  throws CheckUnavailableError — callers report "unchecked", never a pass. */
export function gatewayAsk(tenantId: string, fetchImpl: typeof fetch = fetch): AskFn {
  return async (parts) => {
    const content = parts.map((p) => ('text' in p
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.image.mime};base64,${p.image.data}` } }))
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
          body: JSON.stringify({ model: PRO_CHECK_MODEL, temperature: 0, max_tokens: 4000, messages: [{ role: 'user', content }] }),
        })
        if (!res.ok) throw new Error(`gateway ${res.status}`)
        const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        if (tenantId && json.usage) {
          persistCost({ tenantId, agentId: 'check-clip', workflowId: 'media-understanding', model: PRO_CHECK_MODEL, inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 })
        }
        const v = parseJsonObject(json.choices?.[0]?.message?.content ?? '')
        if (!v) throw new Error('unreadable verdict')
        return v
      } catch (err) {
        lastErr = err
      }
    }
    throw new CheckUnavailableError(`check unavailable: ${(lastErr as Error)?.message ?? 'unknown'}`)
  }
}

export const evenTimes = (duration: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => r2((duration * (i + 1)) / (count + 1)))
export const lastTimes = (duration: number): number[] =>
  [r2(duration * 0.75), r2(duration * 0.88), r2(Math.max(0, duration - 0.1))]

let sampleSeq = 0
/** Full-resolution frames (no scaling): small frames hid a still-on cap. */
export async function sampleFrames(clipPath: string, times: number[], workDir: string): Promise<Img[]> {
  const batch = ++sampleSeq
  const out: Img[] = []
  for (const [i, t] of times.entries()) {
    const f = join(workDir, `s${batch}-${i}.jpg`)
    await execFile('ffmpeg', ['-y', '-ss', String(t), '-i', clipPath, '-frames:v', '1', '-q:v', '2', f], { timeout: 30_000 })
    out.push({ data: readFileSync(f).toString('base64'), mime: 'image/jpeg' })
  }
  return out
}

export function productQuestion(scale: ProductScale, expectedState?: string): string {
  const attrs = scale === 'wide'
    ? 'the label colour and the logo text (the product is small in this shot, so do not judge shape or material)'
    : 'the material (real glass vs plastic), the shape and proportions, the cap or closure colour and type, the label colour and the logo text'
  const state = expectedState ? ` In this shot it is expected that: ${expectedState}. That is normal, not a difference.` : ''
  return `Image P is the exact product. Image F is one frame from an ad. Look only at the product.${state} A hand covering part of the label is normal. visible: is the product clearly visible in Image F? same: if visible, does it match Image P in ${attrs}? (same is true if the product does not appear). Reply ONLY JSON {"visible":true|false,"same":true|false,"why":"short"}`
}

export async function checkProduct(ask: AskFn, product: Img, frames: Img[], opts: { scale: ProductScale; expectedState?: string; mustBeVisible: boolean }): Promise<{ passed: boolean; reason: string; allVisible: boolean }> {
  const q = productQuestion(opts.scale, opts.expectedState)
  const verdicts = await Promise.all(frames.map((f) => ask([{ text: 'Image P:' }, { image: product }, { text: 'Image F:' }, { image: f }, { text: q }])))
  const fails: string[] = []
  let allVisible = true
  verdicts.forEach((v, i) => {
    const visible = v.visible === true
    if (!visible) allVisible = false
    if (opts.mustBeVisible && !visible) fails.push(`frame ${i + 1}: product not visible`)
    else if (visible && v.same === false) fails.push(`frame ${i + 1}: ${String(v.why ?? 'a different product')}`)
  })
  return { passed: fails.length === 0, allVisible, reason: fails.length ? `Product check failed — ${fails.join('; ')}.` : 'Product matches.' }
}

export const GLITCH_QUESTION = 'Image F is one frame from an ad. Answer each strictly: duplicate_object (an object that should be single appears twice, e.g. two bottles in one hand, two identical machines), stray_face (a face where none belongs, e.g. on a machine, wall or object), invented_text (any text or logo on props other than the real product label), cg_effect (cartoon or CG effects such as smoke puffs, sparkles or glowing outlines), flat_background (a flat graphic background where a real place is expected). Reply ONLY JSON {"duplicate_object":true|false,"stray_face":true|false,"invented_text":true|false,"cg_effect":true|false,"flat_background":true|false,"what":"short"}'
const GLITCH_KEYS = ['duplicate_object', 'stray_face', 'invented_text', 'cg_effect', 'flat_background'] as const

export async function checkGlitches(ask: AskFn, frames: Img[]): Promise<{ passed: boolean; reason: string }> {
  const verdicts = await Promise.all(frames.map((f) => ask([{ image: f }, { text: GLITCH_QUESTION }])))
  const fails = verdicts.flatMap((v, i) => {
    const hit = GLITCH_KEYS.filter((k) => v[k] === true)
    return hit.length ? [`frame ${i + 1}: ${hit.join(', ').replace(/_/g, ' ')} (${String(v.what ?? '')})`] : []
  })
  return { passed: fails.length === 0, reason: fails.length ? `Visible glitch — ${fails.join('; ')}.` : 'No glitches.' }
}

export const EXTRAS_QUESTION = 'Image F is one frame from an ad. Besides the main person (if any), are other people visible in the background? Reply ONLY JSON {"extras":true|false}'

export async function checkExtras(ask: AskFn, frames: Img[]): Promise<{ passed: boolean; reason: string }> {
  const verdicts = await Promise.all(frames.map((f) => ask([{ image: f }, { text: EXTRAS_QUESTION }])))
  const empty = verdicts.filter((v) => v.extras !== true).length
  const passed = frames.length === 1 ? empty === 0 : empty < 2
  return { passed, reason: passed ? 'Background people present.' : `The background is empty in ${empty} of ${frames.length} frames; this place needs people in it.` }
}

export const CLONE_QUESTION = 'Image L is the lead actor. Image F is one frame from the ad. Ignore the main person (the lead). List every OTHER person in Image F and, for each, say whether they look like the lead in Image L (similar face, hair, skin tone or outfit). Reply ONLY JSON {"others":[{"where":"short","looks_like_lead":true|false}]}'

export async function checkLeadClone(ask: AskFn, lead: Img, frames: Img[]): Promise<{ passed: boolean; reason: string }> {
  const verdicts = await Promise.all(frames.map((f) => ask([{ text: 'Image L:' }, { image: lead }, { text: 'Image F:' }, { image: f }, { text: CLONE_QUESTION }])))
  const clones: string[] = []
  verdicts.forEach((v, i) => {
    const others = Array.isArray(v.others) ? v.others as Array<{ where?: unknown; looks_like_lead?: unknown }> : []
    for (const o of others) if (o.looks_like_lead === true) clones.push(`frame ${i + 1}: ${String(o.where ?? 'background')}`)
  })
  return { passed: clones.length === 0, reason: clones.length ? `LEAD_CLONED: a background person looks like the lead (${clones.join('; ')}).` : 'No lookalikes.' }
}

export const LEAD_FACE_QUESTION = 'Image L is the lead actor. Image F is a still from the ad. Is the lead in Image F with the same face and hair? Reply ONLY JSON {"lead_present":true|false,"same_face":true|false,"why":"short"}'

export async function checkLeadFace(ask: AskFn, lead: Img, frame: Img): Promise<{ passed: boolean; reason: string }> {
  const v = await ask([{ text: 'Image L:' }, { image: lead }, { text: 'Image F:' }, { image: frame }, { text: LEAD_FACE_QUESTION }])
  const passed = v.lead_present === true && v.same_face === true
  return { passed, reason: passed ? 'The lead is the same person.' : `The lead is missing or looks different: ${String(v.why ?? '')}.` }
}

export const actionLocateQuestion = (action: string): string =>
  `The frames above are from one video clip in time order, each labelled with its time. Expected action: "${action}". At which labelled time does the key moment of that action happen? Use null if it never happens. Reply ONLY JSON {"action_time":<seconds>|null}`
export const PHYSICS_QUESTION = 'The frames above are from one video clip in time order. Does anything physically impossible happen — an object leaves but is still there (e.g. a cap flies off while the bottle stays capped), or objects appear or vanish? Reply ONLY JSON {"impossible":true|false,"what":"short"}'
// v5's ending: the spin turned back the other way halfway (user: "spun but in
// between spun back to original… awkward dance"). Asked on the same 8 frames.
export const REVERSAL_QUESTION = 'The frames above are from one video clip in time order. Does any movement reverse or undo itself mid-way — a spin that turns back the other way, a step that rewinds, a gesture played backwards? Reply ONLY JSON {"reversal":true|false,"what":"short"}'
export const endStateQuestion = (endState: string): string =>
  `Is this true in Image F: "${endState}"? Look closely at the relevant object. Reply ONLY JSON {"holds":true|false,"why":"short"}`

export async function checkAction(ask: AskFn, frames: { t: number; img: Img }[], last: Img[], action: string, endState?: string): Promise<{ passed: boolean; actionTime: number | null; endStateTrue: boolean; reversed: boolean; reason: string }> {
  const timeline: AskPart[] = [{ text: 'Frames from one video clip, in time order:' }]
  for (const f of frames) timeline.push({ text: `t=${f.t}s` }, { image: f.img })
  const [loc, phys, rev] = await Promise.all([
    ask([...timeline, { text: actionLocateQuestion(action) }]),
    ask([...timeline, { text: PHYSICS_QUESTION }]),
    ask([...timeline, { text: REVERSAL_QUESTION }]),
  ])
  const actionTime = typeof loc.action_time === 'number' ? loc.action_time : null
  const endFails: string[] = []
  if (endState) {
    const verdicts = await Promise.all(last.map((f) => ask([{ text: 'Image F:' }, { image: f }, { text: endStateQuestion(endState) }])))
    verdicts.forEach((v, i) => { if (v.holds !== true) endFails.push(`frame ${i + 1}: ${String(v.why ?? 'not true')}`) })
  }
  const endStateTrue = endFails.length === 0
  const reasons: string[] = []
  if (actionTime === null) reasons.push(`The action never happens: "${action}".`)
  if (!endStateTrue) reasons.push(`ACTION_NOT_COMPLETED: "${endState}" is not true at the end (${endFails.join('; ')}).`)
  if (phys.impossible === true) reasons.push(`Something impossible happens: ${String(phys.what ?? '')}.`)
  const reversed = rev.reversal === true
  if (reversed) reasons.push(`Movement reverses mid-way: ${String(rev.what ?? '')}.`)
  return { passed: reasons.length === 0, actionTime, endStateTrue, reversed, reason: reasons.join(' ') || 'The action happens and its end state holds.' }
}

/** C8: centre the shot's window on the action; no action found → the old 0.4s start. */
export function trimStartFor(actionTime: number | null, durationSeconds: number, clipLength: number): number {
  const latest = Math.max(0, clipLength - durationSeconds)
  if (actionTime === null) return r2(Math.min(0.4, latest))
  return r2(Math.min(latest, Math.max(0, actionTime - 0.4 * durationSeconds)))
}

export interface NarrowClipInputs {
  duration: number
  product?: Img
  productScale?: ProductScale
  productExpectedState?: string
  productMustBeVisible?: boolean
  expectExtras?: boolean
  lead?: Img
  action?: string
  endState?: string
  shotDurationSeconds?: number
}
export interface NarrowClipResult {
  passed: boolean
  reasons: string[]
  glitchFree: boolean
  productVisible?: boolean
  extrasPresent?: boolean
  leadClone?: boolean
  actionHappened?: boolean
  motionReversed?: boolean
  actionTime?: number | null
  endStateTrue?: boolean
  trimStartSeconds?: number
}

export async function runNarrowClipChecks(ask: AskFn, sample: (times: number[]) => Promise<Img[]>, input: NarrowClipInputs): Promise<NarrowClipResult> {
  const reasons: string[] = []
  const out: NarrowClipResult = { passed: true, reasons, glitchFree: true }
  const three = await sample(evenTimes(input.duration, 3))
  const g = await checkGlitches(ask, three)
  out.glitchFree = g.passed
  if (!g.passed) reasons.push(g.reason)
  if (input.product && (input.productScale || input.productMustBeVisible)) {
    const five = await sample(evenTimes(input.duration, 5))
    const p = await checkProduct(ask, input.product, five, { scale: input.productScale ?? 'medium', expectedState: input.productExpectedState, mustBeVisible: !!input.productMustBeVisible })
    out.productVisible = p.allVisible
    if (!p.passed) reasons.push(p.reason)
  }
  if (input.expectExtras) {
    const e = await checkExtras(ask, three)
    out.extrasPresent = e.passed
    if (!e.passed) reasons.push(e.reason)
  }
  if (input.lead) {
    const c = await checkLeadClone(ask, input.lead, three)
    out.leadClone = !c.passed
    if (!c.passed) reasons.push(c.reason)
  }
  if (input.action) {
    const times = evenTimes(input.duration, 8)
    const eight = await sample(times)
    const last = input.endState ? await sample(lastTimes(input.duration)) : []
    const a = await checkAction(ask, times.map((t, i) => ({ t, img: eight[i] })), last, input.action, input.endState)
    out.actionHappened = a.actionTime !== null
    out.motionReversed = a.reversed
    out.actionTime = a.actionTime
    if (input.endState) out.endStateTrue = a.endStateTrue
    if (!a.passed) reasons.push(a.reason)
    if (input.shotDurationSeconds) out.trimStartSeconds = trimStartFor(a.actionTime, input.shotDurationSeconds, input.duration)
  }
  out.passed = reasons.length === 0
  return out
}

export interface StillInputs {
  product?: Img
  productScale?: ProductScale
  productMustBeVisible?: boolean
  expectExtras?: boolean
  lead?: Img
  leadInShot?: boolean
}

export async function runStillChecks(ask: AskFn, still: Img, input: StillInputs): Promise<{ passed: boolean; reasons: string[] }> {
  const reasons: string[] = []
  const g = await checkGlitches(ask, [still])
  if (!g.passed) reasons.push(g.reason)
  if (input.product) {
    const p = await checkProduct(ask, input.product, [still], { scale: input.productScale ?? 'medium', mustBeVisible: !!input.productMustBeVisible })
    if (!p.passed) reasons.push(p.reason)
  }
  if (input.expectExtras) {
    const e = await checkExtras(ask, [still])
    if (!e.passed) reasons.push(e.reason)
  }
  if (input.lead) {
    if (input.leadInShot) {
      const f = await checkLeadFace(ask, input.lead, still)
      if (!f.passed) reasons.push(f.reason)
    }
    const c = await checkLeadClone(ask, input.lead, [still])
    if (!c.passed) reasons.push(c.reason)
  }
  return { passed: reasons.length === 0, reasons }
}

export const FACE_BOX_QUESTION = 'Find every human face in this image. Reply ONLY JSON {"faces":[{"x0":0,"y0":0,"x1":0,"y1":0}]} with coordinates as fractions (0 to 1) of the image width and height; {"faces":[]} if there are none.'

export async function faceBoxes(ask: AskFn, frame: Img): Promise<Box[]> {
  const v = await ask([{ image: frame }, { text: FACE_BOX_QUESTION }])
  const faces = Array.isArray(v.faces) ? v.faces as Array<Record<string, unknown>> : []
  return faces.filter((f) => ['x0', 'y0', 'x1', 'y1'].every((k) => typeof f[k] === 'number'))
    .map((f) => ({ x0: f.x0 as number, y0: f.y0 as number, x1: f.x1 as number, y1: f.y1 as number }))
}

// Vertical bands the overlay_text positions occupy (fractions of height).
export const TEXT_BANDS: Record<'top' | 'center' | 'bottom', [number, number]> = { top: [0, 0.25], center: [0.38, 0.62], bottom: [0.75, 1] }

export function chooseTextPosition(faces: Box[], preferred: 'top' | 'center' | 'bottom'): { position: 'top' | 'center' | 'bottom'; shrink: boolean } {
  const hits = (p: 'top' | 'center' | 'bottom') => faces.some((f) => f.y0 < TEXT_BANDS[p][1] && f.y1 > TEXT_BANDS[p][0])
  const order = [preferred, ...(['top', 'center', 'bottom'] as const).filter((p) => p !== preferred)]
  const free = order.find((p) => !hits(p))
  return free ? { position: free, shrink: false } : { position: 'top', shrink: true }
}

export function chooseCardColumn(faces: Box[]): 'center' | 'left' | 'right' {
  const cols: Record<'center' | 'left' | 'right', [number, number]> = { left: [0, 0.33], center: [0.33, 0.67], right: [0.67, 1] }
  const hits = (c: 'center' | 'left' | 'right') => faces.some((f) => f.x0 < cols[c][1] && f.x1 > cols[c][0])
  return (['center', 'right', 'left'] as const).find((c) => !hits(c)) ?? 'center'
}
```

- [ ] **Step 3b: Fix the test's clone-still fake answer**

Check that the `runStillChecks` test's `fakeAsk` routes on `'OTHER person'`, which is a phrase in `CLONE_QUESTION`. The extras question must not contain it.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcChecks.test.ts`
Expected: PASS. If a routing string in a fake answer no longer matches a question text, fix the **question text** to keep the phrase the test routes on (`at which`, `impossible`, `duplicate_object`, `OTHER person`).

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check`
Expected: clean.

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts apps/agent-orchestrator/src/mastra/tools/tvcChecks.test.ts
git commit -m "feat(orchestrator): narrow high-res TVC checks on gemini-2.5-pro

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `check_clip` runs the narrow checks when the plan asks for them (C1–C8)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/checkClip.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/checkClip.test.ts`

**Interfaces:**
- Consumes: Task 2's `gatewayAsk`, `sampleFrames`, `runNarrowClipChecks`, `CheckUnavailableError`, `ProductScale`.
- Produces:
  - **New optional inputs:** `productMustBeVisible`, `productScale` (`'close' | 'medium' | 'wide'`), `productExpectedState`, `expectExtras`, `leadFileId`, `action`, `endState`, `shotDurationSeconds`.
  - **New optional outputs:** `productVisible`, `extrasPresent`, `leadClone`, `glitchFree`, `actionHappened`, `motionReversed`, `actionTime`, `endStateTrue`, `trimStartSeconds`.
  - **New refusal:** `CHECK_UNAVAILABLE: ...`.
  - **Exports:** `export async function fetchBase64(...)` and `export function narrowWanted(i: { productMustBeVisible?: boolean; productScale?: string; expectExtras?: boolean; leadFileId?: string; action?: string }): boolean`.

- [ ] **Step 1: Write the failing tests** (append to `checkClip.test.ts`)

```ts
import { vi } from 'vitest'
import { narrowWanted, droppedCheckInputs as dropped2 } from './checkClip.js'

describe('narrow checks are opt-in (Review Focus 1)', () => {
  it('a legacy call makes no narrow checks', () => {
    expect(narrowWanted({})).toBe(false)
    expect(narrowWanted({ productScale: 'close' })).toBe(true)
    expect(narrowWanted({ action: 'cap pops off' })).toBe(true)
    expect(narrowWanted({ leadFileId: 'av1' })).toBe(true)
  })
  it('the re-check guard refuses dropping a narrow input', () => {
    expect(dropped2('conv:clipN', { expectedLine: false, product: true, reference: false, productVisible: true, extras: true, lead: true, action: true })).toEqual([])
    expect(dropped2('conv:clipN', { expectedLine: false, product: true, reference: false, productVisible: false, extras: true, lead: true, action: true })).toEqual(['productVisible'])
    expect(dropped2('conv:clipN', { expectedLine: false, product: true, reference: false, productVisible: true, extras: true, lead: false, action: false })).toEqual(['lead', 'action'])
  })
})
```

And a tool-level test file `apps/agent-orchestrator/src/mastra/tools/checkClip.narrow.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
vi.mock('./avatarReferences.js', () => ({ resolveAvatarReferences: vi.fn(async () => ({ fileIds: [] })) }))
vi.mock('./oneVideoPerTurn.js', () => ({ markCheckFailed: vi.fn() }))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async (id: string) => `https://s3.example/${id}`) }))
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile }))
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(() => Buffer.from('jpg')), writeFileSync: vi.fn() }
})
const { runNarrowClipChecks } = vi.hoisted(() => ({ runNarrowClipChecks: vi.fn() }))
vi.mock('./tvcChecks.js', async (orig) => {
  const actual = await orig<typeof import('./tvcChecks.js')>()
  return { ...actual, runNarrowClipChecks, gatewayAsk: () => async () => ({}) }
})

import { checkClip } from './checkClip.js'
import { CheckUnavailableError } from './tvcChecks.js'

function ctx() {
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', conversationId: 'c-narrow', idToken: 'tok' })) rc.set(k, v)
  return { requestContext: rc, agent: { toolCallId: 'x', messages: [] } } as never
}

beforeEach(() => {
  vi.resetAllMocks()
  execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0\n', stderr: '' }))
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/v1/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"scene_same":true,"glitch":false,"confidence":9,"differences":"none","heard":""}' } }] }), { status: 200 })
    }
    return new Response(Buffer.from('bytes'), { status: 200, headers: { 'content-type': String(url).includes('clip') ? 'video/mp4' : 'image/jpeg' } })
  }) as unknown as typeof fetch
})

describe('check_clip narrow checks', () => {
  it('fails the clip when a narrow check fails, and returns the trim window', async () => {
    runNarrowClipChecks.mockResolvedValue({ passed: false, reasons: ['ACTION_NOT_COMPLETED: "the bottle has no cap" is not true at the end.'], glitchFree: true, actionHappened: true, actionTime: 1.34, endStateTrue: false, trimStartSeconds: 0.99 })
    const r = await checkClip.execute!({ clipFileId: 'clip1', masterStillFileId: 'still1', noPerson: true, expectNoSpeech: false, action: 'cap pops off', endState: 'the bottle has no cap', shotDurationSeconds: 0.88 } as never, ctx())
    expect(r).toMatchObject({ passed: false, endStateTrue: false, trimStartSeconds: 0.99, reason: expect.stringMatching(/ACTION_NOT_COMPLETED/) })
  })
  it('reports CHECK_UNAVAILABLE (never a pass) when the Pro check cannot run', async () => {
    runNarrowClipChecks.mockRejectedValue(new CheckUnavailableError('check unavailable: gateway 500'))
    const r = await checkClip.execute!({ clipFileId: 'clip2', masterStillFileId: 'still1', noPerson: true, productScale: 'close', productFileId: 'prod1' } as never, ctx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/) })
  })
  it('a legacy call never calls the narrow checks', async () => {
    await checkClip.execute!({ clipFileId: 'clip3', masterStillFileId: 'still1', noPerson: true } as never, ctx())
    expect(runNarrowClipChecks).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/checkClip.test.ts src/mastra/tools/checkClip.narrow.test.ts`
Expected: FAIL. `narrowWanted` is not exported, and the new inputs are unknown.

- [ ] **Step 3: Implement**

In `checkClip.ts`:

1. Imports: add `import { CheckUnavailableError, gatewayAsk, runNarrowClipChecks, sampleFrames, type NarrowClipResult, type ProductScale } from './tvcChecks.js'`.

2. Constants: add `const NARROW_TIMEOUT_MS = 600_000`.

3. Re-check guard: replace the `CheckInputs` type and `CHECK_KEYS`:

```ts
type CheckInputs = { expectedLine: boolean; product: boolean; reference: boolean; noSpeech?: boolean; presenter?: boolean; productVisible?: boolean; extras?: boolean; lead?: boolean; action?: boolean }
const CHECK_KEYS = ['expectedLine', 'product', 'reference', 'noSpeech', 'presenter', 'productVisible', 'extras', 'lead', 'action'] as const
```

In `droppedCheckInputs`'s `checkedWith.set(...)` object, add:

```ts
      productVisible: !!now.productVisible || !!before?.productVisible,
      extras: !!now.extras || !!before?.extras,
      lead: !!now.lead || !!before?.lead,
      action: !!now.action || !!before?.action,
```

4. Change `async function fetchBase64` to `export async function fetchBase64`.

5. Add the opt-in predicate below `judgeVerdict`:

```ts
/** The TVC flow's narrow checks run only when the plan passes their inputs;
 *  talking-head and UGC calls never pass them and behave exactly as before. */
export function narrowWanted(i: { productMustBeVisible?: boolean; productScale?: string; expectExtras?: boolean; leadFileId?: string; action?: string }): boolean {
  return !!(i.productMustBeVisible || i.productScale || i.expectExtras || i.leadFileId || i.action)
}
```

6. Add to `inputSchema` (after `noPerson`):

```ts
    productMustBeVisible: z.boolean().optional().describe('TVC: the plan says the product is in this shot; the clip fails if it is missing in any sampled frame'),
    productScale: z.enum(['close', 'medium', 'wide']).optional().describe('TVC: how big the product is in the shot; wide judges only colour and label'),
    productExpectedState: z.string().optional().describe('TVC: a normal state of the product in this shot, e.g. "the bottle has no cap after the pop"'),
    expectExtras: z.boolean().optional().describe('TVC: this place needs background people; an empty background fails'),
    leadFileId: z.string().optional().describe('TVC: the lead actor\'s image; a background person who looks like the lead fails the clip'),
    action: z.string().optional().describe('TVC: the shot\'s action; the clip fails if it never happens'),
    endState: z.string().optional().describe('TVC: what must be true at the end, e.g. "the bottle has no cap"'),
    shotDurationSeconds: z.number().positive().optional().describe('TVC: the shot\'s planned length; returns trimStartSeconds centred on the action'),
```

Add to `outputSchema`:

```ts
    productVisible: z.boolean().optional(),
    extrasPresent: z.boolean().optional(),
    leadClone: z.boolean().optional(),
    glitchFree: z.boolean().optional(),
    actionHappened: z.boolean().optional(),
    motionReversed: z.boolean().optional(),
    actionTime: z.number().nullable().optional(),
    endStateTrue: z.boolean().optional(),
    trimStartSeconds: z.number().optional(),
```

7. In `execute`:
   - Extend the destructuring and its type with the eight new fields.
   - Compute `const narrow = narrowWanted({ productMustBeVisible, productScale, expectExtras, leadFileId, action })`.
   - Pass to `droppedCheckInputs`: `productVisible: !!productMustBeVisible, extras: !!expectExtras, lead: !!leadFileId, action: !!action`.
   - Change the timer to `setTimeout(() => controller.abort(), narrow ? NARROW_TIMEOUT_MS : TIMEOUT_MS)`.

8. Hoist the clip path and duration so they outlive the `else` block. Before `if (isStill)`, add `let clipPath: string | null = null` and `let duration = 4`. Inside the `else`:
   - change `const clipPath = join(workDir, 'clip.mp4')` to `clipPath = join(workDir, 'clip.mp4')`;
   - change `const duration = Number(stdout.trim()) || 4` to `duration = Number(stdout.trim()) || 4`;
   - keep using `clipPath!` where the old code used `clipPath`.

9. Replace the block from `const judged = judgeVerdict(...)` to the end of the success `return` with:

```ts
      const judged = judgeVerdict(verdict, { expectedLine, audioChecked: !!audio, expectNoSpeech: !!expectNoSpeech, noPerson: !!noPerson, soundChecked: !!refAudio })
      let narrowResult: NarrowClipResult | null = null
      if (narrow && clipPath) {
        try {
          const productImg = productFileId ? await fetchBase64(productFileId, idToken, controller.signal) : undefined
          const leadImg = leadFileId ? await fetchBase64(leadFileId, idToken, controller.signal) : undefined
          narrowResult = await runNarrowClipChecks(gatewayAsk(tenantId), (times) => sampleFrames(clipPath!, times, workDir), {
            duration, product: productImg, productScale: productScale as ProductScale | undefined, productExpectedState, productMustBeVisible,
            expectExtras, lead: leadImg, action, endState, shotDurationSeconds,
          })
        } catch (err) {
          if (err instanceof CheckUnavailableError) return { refused: true, refusalReason: `CHECK_UNAVAILABLE: ${err.message} — this clip is unchecked; do not use it as checked` }
          throw err
        }
      }
      const passed = judged.passed && (narrowResult ? narrowResult.passed : true)
      const reason = !judged.passed ? judged.reason : narrowResult && !narrowResult.passed ? narrowResult.reasons.join(' ') : judged.reason
      if (!passed) {
        markCheckFailed(execContext?.requestContext, (execContext as unknown as { agent?: { messages?: unknown } })?.agent?.messages)
      }
      return {
        passed, samePerson: judged.samePerson, lineMatches: judged.lineMatches,
        productMatches: judged.productMatches, glitch: verdict.glitch, soundMatches: judged.soundMatches,
        heard: verdict.heard, reason,
        ...(narrowResult ? {
          glitchFree: narrowResult.glitchFree, productVisible: narrowResult.productVisible, extrasPresent: narrowResult.extrasPresent,
          leadClone: narrowResult.leadClone, actionHappened: narrowResult.actionHappened, motionReversed: narrowResult.motionReversed, actionTime: narrowResult.actionTime,
          endStateTrue: narrowResult.endStateTrue, trimStartSeconds: narrowResult.trimStartSeconds,
        } : {}),
      }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/checkClip.test.ts src/mastra/tools/checkClip.narrow.test.ts`
Expected: PASS (all existing checkClip tests unchanged).

- [ ] **Step 5: Full suite, type-check, commit**

Run: `pnpm --filter agent-orchestrator test && pnpm --filter agent-orchestrator type-check`

```bash
git add apps/agent-orchestrator/src/mastra/tools/checkClip.ts apps/agent-orchestrator/src/mastra/tools/checkClip.test.ts apps/agent-orchestrator/src/mastra/tools/checkClip.narrow.test.ts
git commit -m "feat(orchestrator): check_clip runs narrow product, clone, extras and action checks for TVC shots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: the `check_still` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/checkStill.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/checkStill.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (both tool maps)

**Interfaces:**
- Consumes: Task 2's `runStillChecks`, `gatewayAsk`, `CheckUnavailableError`; Task 3's `fetchBase64`.
- Produces:
  - tool `check_still` (id `check-still`)
  - `export function stillPassedCheck(conversationId: string, stillFileId: string): boolean`
  - `export function markStillPassed(conversationId: string, stillFileId: string): void`

- [ ] **Step 1: Write the failing tests**

Create `checkStill.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
const { fetchBase64 } = vi.hoisted(() => ({ fetchBase64: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })) }))
vi.mock('./checkClip.js', () => ({ fetchBase64 }))
const { runStillChecks } = vi.hoisted(() => ({ runStillChecks: vi.fn() }))
vi.mock('./tvcChecks.js', async (orig) => {
  const actual = await orig<typeof import('./tvcChecks.js')>()
  return { ...actual, runStillChecks, gatewayAsk: () => async () => ({}) }
})

import { checkStill, stillPassedCheck, markStillPassed } from './checkStill.js'
import { CheckUnavailableError } from './tvcChecks.js'

function ctx(conv = 'c-still') {
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', conversationId: conv, idToken: 'tok' })) rc.set(k, v)
  return { requestContext: rc } as never
}

beforeEach(() => { runStillChecks.mockReset() })

describe('check_still', () => {
  it('records a passing still so plan_tvc will accept it', async () => {
    runStillChecks.mockResolvedValue({ passed: true, reasons: [] })
    const r = await checkStill.execute!({ stillFileId: 's1', productFileId: 'p1', productScale: 'close', productMustBeVisible: true } as never, ctx())
    expect(r).toMatchObject({ passed: true })
    expect(stillPassedCheck('c-still', 's1')).toBe(true)
  })
  it('a failing still is not recorded and returns the reasons', async () => {
    runStillChecks.mockResolvedValue({ passed: false, reasons: ['LEAD_CLONED: a background person looks like the lead (frame 1: left).'] })
    const r = await checkStill.execute!({ stillFileId: 's2', actorFileId: 'av1', expectExtras: true } as never, ctx())
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/LEAD_CLONED/) })
    expect(stillPassedCheck('c-still', 's2')).toBe(false)
  })
  it('an unreachable check is CHECK_UNAVAILABLE, never a pass', async () => {
    runStillChecks.mockRejectedValue(new CheckUnavailableError('check unavailable: gateway 500'))
    const r = await checkStill.execute!({ stillFileId: 's3' } as never, ctx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/) })
    expect(stillPassedCheck('c-still', 's3')).toBe(false)
  })
  it('passed stills are per conversation', () => {
    markStillPassed('a', 'x')
    expect(stillPassedCheck('a', 'x')).toBe(true)
    expect(stillPassedCheck('b', 'x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/checkStill.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**

Create `checkStill.ts`:

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchBase64 } from './checkClip.js'
import { CheckUnavailableError, gatewayAsk, runStillChecks, type ProductScale } from './tvcChecks.js'

// Checks a TVC still BEFORE it is animated (spec §3.3): the product, glitches,
// background people and the lead (same face; nobody else looks like her).
// Free to the user. Proven 2026-10-05: a squat bottle was fixed on retry, and
// a wide shot that failed twice was held back instead of animated.
const passedStills = new Map<string, true>()
export function markStillPassed(conversationId: string, stillFileId: string): void {
  if (passedStills.size > 2000) passedStills.delete(passedStills.keys().next().value as string)
  passedStills.set(`${conversationId}:${stillFileId}`, true)
}
export function stillPassedCheck(conversationId: string, stillFileId: string): boolean {
  return passedStills.has(`${conversationId}:${stillFileId}`)
}

export const checkStill = createTool({
  id: 'check-still',
  description: 'Free check of a TVC still before it is animated: the product matches the product photo, no glitches (duplicates, stray faces, invented text, CG effects, flat backgrounds), background people where the place needs them, and the lead is the same person with no lookalike behind her. On fail, generate the still once more with the reason added; on a second fail, return it to Olmo. plan_tvc only records stills that passed here (or that the user kept).',
  inputSchema: z.object({
    stillFileId: z.string().describe('The still to check'),
    productFileId: z.string().optional().describe('The product photo, when the product is in the shot'),
    productScale: z.enum(['close', 'medium', 'wide']).optional().describe('How big the product is in the shot; wide judges only colour and label'),
    productMustBeVisible: z.boolean().optional().describe('The plan says the product is visible in this shot'),
    expectExtras: z.boolean().optional().describe('This place needs background people'),
    actorFileId: z.string().optional().describe('The lead actor (avatar) image'),
    leadInShot: z.boolean().optional().describe('The lead is in this shot (checks it is the same face)'),
  }),
  outputSchema: z.object({
    passed: z.boolean().optional(),
    reason: z.string().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const i = inputData as { stillFileId: string; productFileId?: string; productScale?: ProductScale; productMustBeVisible?: boolean; expectExtras?: boolean; actorFileId?: string; leadInShot?: boolean }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined ?? ''
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    const signal = AbortSignal.timeout(300_000)
    try {
      const [still, product, lead] = await Promise.all([
        fetchBase64(i.stillFileId, idToken, signal),
        i.productFileId ? fetchBase64(i.productFileId, idToken, signal) : Promise.resolve(undefined),
        i.actorFileId ? fetchBase64(i.actorFileId, idToken, signal) : Promise.resolve(undefined),
      ])
      const r = await runStillChecks(gatewayAsk(tenantId), still, {
        product, productScale: i.productScale, productMustBeVisible: i.productMustBeVisible,
        expectExtras: i.expectExtras, lead, leadInShot: i.leadInShot,
      })
      if (r.passed) markStillPassed(conversationId, i.stillFileId)
      return { passed: r.passed, reason: r.passed ? 'The still passed every check.' : r.reasons.join(' ') }
    } catch (err) {
      if (err instanceof CheckUnavailableError) return { refused: true, refusalReason: `CHECK_UNAVAILABLE: ${err.message} — this still is unchecked` }
      console.error('[checkStill] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'CHECK_FAILED' }
    }
  },
})
```

In `directorAgent.ts`:
- Add `import { checkStill } from '../tools/checkStill.js'` next to the `checkClip` import.
- Append `check_still: checkStill` to BOTH `tools` maps, right after `mix_voiceover: mixVoiceover`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/checkStill.test.ts src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check`

```bash
git add apps/agent-orchestrator/src/mastra/tools/checkStill.ts apps/agent-orchestrator/src/mastra/tools/checkStill.test.ts apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): check_still checks a TVC still before it is animated

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: plan rules for shots (P1, P2, P7, P8, P9, P10) and 12 shots

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts`

**Interfaces:**
- Produces:
  - **Shot fields:** `endState?: string`, `continuesFrom?: number`, `angle?: 'eye' | 'low' | 'high' | 'top' | 'side' | 'pov'`, `flashCut?: boolean`.
  - **Brief fields:**
    - `reference?: { productType?: ProductType; cutTimes?: number[] }`
    - `product?: ProductType`, where `ProductType = { material: 'glass' | 'plastic' | 'metal' | 'paper' | 'other'; closure: string; openedBy: string }`. Its checks come in Task 7.
  - **Constants and helpers:**
    - `MAX_SHOTS = 12`
    - `export const HARD_ACTION_RE`
    - `export const TURN_RE`, `export function turnIsComplete(action: string): boolean` (P10: a turn names one direction and is complete; plan error otherwise)
    - `export function generateSecondsFor(shot: TvcShot): number`
    - `export function minShotSeconds(plan: TvcPlan, shot: TvcShot): number`
  - **Slice fields per shot** (`shots a-b`): `generateSeconds`, `startFromPreviousLastFrame`, `trimStartSeconds` (0 for a continuing shot, otherwise 0.4), `trimToEnd` (true when the next shot continues from this one).

- [ ] **Step 1: Write the failing tests** (append to `tvcPlan.test.ts`; update the existing 8-shot test)

Change the existing test to:

```ts
  it('at most 12 shots (assemble_clips joins at most 12 clips)', () => {
    expect(validateTvcPlan(plan20(13)).errors.join(' | ')).toMatch(/13 shots; at most 12/)
  })
```

Append:

```ts
import { generateSecondsFor, minShotSeconds, HARD_ACTION_RE } from './tvcPlan.js'

describe('quality rules (P1, P2, P7–P10)', () => {
  it('P1: generation length covers the shot plus the 0.4s warm-up and margin; line shots get their line', () => {
    const p = goodPlan()
    expect(generateSecondsFor({ ...p.shots[1], durationSeconds: 1.2 })).toBe(3)
    expect(generateSecondsFor({ ...p.shots[1], durationSeconds: 2.5 })).toBe(4)
    expect(generateSecondsFor({ ...p.shots[6], durationSeconds: 3.1 })).toBe(4)
    expect(generateSecondsFor({ ...p.shots[6], durationSeconds: 4 })).toBe(5)
    expect(generateSecondsFor({ ...p.shots[0], line: 'one two three four five six seven eight nine ten eleven twelve' })).toBe(6)
  })
  it('P2: continuesFrom must be the previous shot at the same place; the slice chains it and trims from 0', () => {
    const p = goodPlan()
    p.shots[4].continuesFrom = 3
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shot 5 continues from shot 3; it can only continue the shot right before it/)
    const q = goodPlan()
    q.shots[4].continuesFrom = 4
    q.shots[4].location = 1
    expect(validateTvcPlan(q).errors.join(' | ')).toMatch(/shot 5 continues shot 4 but is at a different place/)
    const ok = goodPlan()
    ok.shots[4].continuesFrom = 4
    expect(validateTvcPlan(ok).errors).toEqual([])
    const slice = sliceTvcPlan(ok, 'shots 4-5') as { shots: Array<{ n: number; startFromPreviousLastFrame: boolean; trimStartSeconds: number; trimToEnd: boolean }> }
    expect(slice.shots[1]).toMatchObject({ n: 5, startFromPreviousLastFrame: true, trimStartSeconds: 0 })
    expect(slice.shots[0]).toMatchObject({ n: 4, trimToEnd: true })
  })
  it('P7: a state-changing action needs an endState', () => {
    const p = goodPlan()
    p.shots[2].action = 'the cap pops off on the opener'
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shot 3 changes an object \("the cap pops off on the opener"\); add endState/)
    p.shots[2].endState = 'the bottle has no cap'
    expect(validateTvcPlan(p).errors).toEqual([])
    expect(HARD_ACTION_RE.test('she pours the tea')).toBe(true)
    expect(HARD_ACTION_RE.test('she smiles')).toBe(false)
  })
  it('P8/P9: same angle and neighbouring sizes is a jump cut; same size needs a different angle', () => {
    const p = goodPlan()
    p.shots[0].angle = 'eye'; p.shots[1].angle = 'eye'
    p.shots[2].size = 'close_up'; p.shots[2].angle = 'side'
    p.shots[3].size = 'close_up'; p.shots[3].angle = 'side'
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shots 3 and 4 are the same size \(close_up\)/)
    const q = goodPlan()
    q.shots[2].angle = 'eye'; q.shots[3].angle = 'eye'
    q.shots[3].size = 'close_up'
    q.shots[2].size = 'extreme_close_up'
    expect(validateTvcPlan(q).errors.join(' | ')).toMatch(/shots 3 and 4 are near-identical framings/)
    const r = goodPlan()
    r.shots[2].size = 'medium'; r.shots[2].angle = 'low'
    r.shots[3].size = 'medium'; r.shots[3].angle = 'eye'
    expect(validateTvcPlan(r).errors.join(' | ')).not.toMatch(/shots 3 and 4/)
  })
  it('P9: minimum shot length — 1.2s, 0.6s with a reference, 0.3s for a flash cut', () => {
    const p = goodPlan()
    expect(minShotSeconds(p, p.shots[1])).toBe(1.2)
    p.brief.reference = { cutTimes: [2, 4] }
    expect(minShotSeconds(p, p.shots[1])).toBe(0.6)
    p.shots[1].flashCut = true
    expect(minShotSeconds(p, p.shots[1])).toBe(0.3)
  })
  it('P10: a payoff without a concrete physical action gets a warning', () => {
    const p = goodPlan()
    p.shots[5].action = 'she feels joyful and free'
    expect(validateTvcPlan(p).warnings.join(' | ')).toMatch(/shot 6 is the payoff/)
    p.shots[5].action = 'she dances and spins all the way around in one direction, 360°'
    expect(validateTvcPlan(p).warnings.join(' | ')).not.toMatch(/payoff/)
  })
  it('P10: a turn must be written as one direction and complete (v5\'s spin reversed mid-way)', () => {
    const p = goodPlan()
    p.shots[5].action = 'she dances and twirls'
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shot 6 has a turn \("she dances and twirls"\); write it as one direction and complete/)
    p.shots[5].action = 'she spins all the way around in one direction, 360°'
    expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/has a turn/)
  })
  it('a plan saved before these fields still validates (Review Focus 3)', () => {
    expect(validateTvcPlan(goodPlan()).errors).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts`
Expected: FAIL. The exports are missing, and the error still says at most 8.

- [ ] **Step 3: Implement**

In `tvcPlan.ts`:

1. `export const MAX_SHOTS = 12`. Update its comment to "assemble_clips joins at most 12 clips".

2. Add above `shotSchema`:

```ts
export const productTypeSchema = z.object({
  material: z.enum(['glass', 'plastic', 'metal', 'paper', 'other']),
  closure: z.string().min(1).describe('e.g. "crown cap", "screw cap", "pump"'),
  openedBy: z.string().min(1).describe('e.g. "bottle opener", "twist", "pull tab"'),
})
export type ProductType = z.infer<typeof productTypeSchema>
// Actions that change an object's state; each needs an endState the clip check verifies.
export const HARD_ACTION_RE = /\b(open|opens|opened|opening|pop|pops|popped|popping|pour|pours|poured|pouring|bite|bites|biting|apply|applies|applying|peel|peels|peeled|peeling|unwrap|unwraps|unwrapped|unwrapping|cut|cuts|cutting)\b/i
const CONCRETE_VERB_RE = /\b(dance|dances|dancing|spin|spins|spinning|twirl|twirls|jump|jumps|laugh|laughs|run|runs|walk|walks|raise|raises|hold|holds|drink|drinks|sip|sips|smile|smiles|wave|waves|turn|turns|clap|claps|hug|hugs|throw|throws|lift|lifts)\b/i
const SIZE_ORDER = ['wide', 'medium', 'close_up', 'extreme_close_up'] as const
// A turn written loosely ("does one twirl") reversed mid-way in v5; a turn
// must say one direction and complete, and C7's reversal question checks it.
export const TURN_RE = /\b(spin|spins|spinning|twirl|twirls|twirling|pirouette|pirouettes|rotate|rotates|rotating|turns? around)\b/i
export const turnIsComplete = (action: string): boolean => /one direction/i.test(action) && /(360|all the way around|full turn)/i.test(action)
```

3. Add to `shotSchema`:

```ts
  endState: z.string().optional().describe('Required when the action changes an object (open, pop, pour, bite, apply, peel, unwrap, cut): what is true after it, e.g. "the bottle has no cap". The clip check verifies it'),
  continuesFrom: z.number().int().min(1).optional().describe('The previous shot\'s number when this shot continues the same action at the same place; its start frame is that clip\'s last frame, and it is trimmed from 0'),
  angle: z.enum(['eye', 'low', 'high', 'top', 'side', 'pov']).optional().describe('Camera angle. The same angle with the same or a neighbouring size as the shot before is a jump cut'),
  flashCut: z.boolean().optional().describe('A deliberate flash cut, allowed down to 0.3s'),
```

4. Add to the `brief` object:

```ts
    reference: z.object({
      productType: productTypeSchema.optional(),
      cutTimes: z.array(z.number().positive()).optional(),
    }).optional().describe('When recreating a reference ad: its product type and its real cut times (detect_cuts)'),
    product: productTypeSchema.optional().describe('This product\'s type; must match the reference\'s when one is given'),
```

5. Add helpers below `legalHoldSeconds`:

```ts
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
export function minShotSeconds(plan: TvcPlan, shot: TvcShot): number {
  if (shot.flashCut) return 0.3
  return plan.brief.reference?.cutTimes?.length ? 0.6 : SHOT_MIN
}
/** P1: the 0.4s warm-up plus a margin, or the line's length; a continuing shot is trimmed from 0. */
export function generateSecondsFor(shot: TvcShot): number {
  const base = shot.continuesFrom ? Math.ceil(shot.durationSeconds + 0.3) : Math.ceil(shot.durationSeconds + 0.4 + 0.3)
  const line = shot.audio === 'line' && shot.line ? Math.ceil(countWords(shot.line) / WORDS_PER_SECOND + 1) : 0
  return clamp(Math.max(base, line), 3, 10)
}
```

6. In `validateTvcPlan`, replace the per-shot duration check's `else if (s.durationSeconds < SHOT_MIN - EPS || ...)` branch with:

```ts
    } else if (s.durationSeconds < minShotSeconds(plan, s) - EPS || s.durationSeconds > SHOT_MAX + EPS) {
      errors.push(`shot ${s.n} is ${s.durationSeconds}s; shots must be ${minShotSeconds(plan, s)}–2.5s`)
    }
```

7. Replace check "9. Shot sizes change." with:

```ts
  // 9. Shot sizes change; the same size needs a different angle; the same
  //    angle with a neighbouring size is a jump cut (v4's two-shot opener).
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1], b = shots[i]
    if (b.continuesFrom) continue
    const sameAngle = !!a.angle && a.angle === b.angle
    if (a.size === b.size && (!a.angle || !b.angle || sameAngle)) {
      errors.push(`shots ${a.n} and ${b.n} are the same size (${b.size}); change one, or give them different angles`)
    } else if (sameAngle && Math.abs(SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size)) === 1) {
      errors.push(`shots ${a.n} and ${b.n} are near-identical framings (same ${b.angle} angle, ${a.size} then ${b.size}): a jump cut. Change the angle, or keep the action in one shot`)
    }
  }
  // P2: continuity only with the shot right before, at the same place.
  shots.forEach((s, i) => {
    if (s.continuesFrom === undefined) return
    if (s.continuesFrom !== s.n - 1) { errors.push(`shot ${s.n} continues from shot ${s.continuesFrom}; it can only continue the shot right before it`); return }
    if (shots[i - 1] && shots[i - 1].location !== s.location) errors.push(`shot ${s.n} continues shot ${s.continuesFrom} but is at a different place`)
  })
  // P10: a turn is one direction and complete.
  shots.forEach((s) => {
    if (TURN_RE.test(s.action) && !turnIsComplete(s.action)) errors.push(`shot ${s.n} has a turn ("${s.action}"); write it as one direction and complete, e.g. "spins all the way around in one direction, 360°"`)
  })
  // P7: a state-changing action needs an end state.
  shots.forEach((s) => {
    if (HARD_ACTION_RE.test(s.action) && !s.endState?.trim()) errors.push(`shot ${s.n} changes an object ("${s.action}"); add endState (what is true after it)`)
  })
```

8. In the warnings section, before `return`:

```ts
  // P10: the payoff (the shot before the packshot) must be a checkable move.
  const payoff = packIdx > 0 ? shots[packIdx - 1] : undefined
  if (payoff && !CONCRETE_VERB_RE.test(payoff.action)) warnings.push(`shot ${payoff.n} is the payoff; write a concrete, physical move the check can verify (e.g. "she dances and spins all the way around in one direction, 360°"), not only a mood`)
```

9. In `sliceTvcPlan`'s `shots a-b` branch, replace `.map(withStart)` with:

```ts
      shots: plan.shots.filter((s) => s.n >= a && s.n <= b).map((s) => ({
        ...withStart(s),
        generateSeconds: generateSecondsFor(s),
        startFromPreviousLastFrame: s.continuesFrom !== undefined,
        trimStartSeconds: s.continuesFrom !== undefined ? 0 : 0.4,
        trimToEnd: plan.shots.some((o) => o.continuesFrom === s.n),
      })),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts`
Expected: PASS. If an existing "same size" test's expected text no longer matches, keep the test's regex: the message still begins `shots X and Y are the same size (`.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check`

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts
git commit -m "feat(orchestrator): TVC plan rules for continuity, end states, angles and 12 shots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: places, extras and the code-built shot prompt (P3, P4)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts`

**Interfaces:**
- Consumes: Task 5's schema.
- Produces:
  - `locations` entries are `string | { name: string; extras?: string }`
  - `brief.actorLook?: string`
  - exports `locationName(loc)`, `locationExtras(loc)`, `varietySentence(actorLook?: string): string`, `CAMERA_GRAMMAR: Record<TvcShot['type'], string>`, `shotPromptFor(plan: TvcPlan, n: number): string`
  - each `shots a-b` slice entry gains `prompt: string`

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { shotPromptFor, varietySentence, locationName, CAMERA_GRAMMAR } from './tvcPlan.js'

describe('places, extras and the shot prompt (P3, P4)', () => {
  function hallwayPlan(): TvcPlan {
    const p = goodPlan()
    p.locations = [{ name: 'busy school hallway', extras: 'students walking past and chatting' }, 'beach at golden hour']
    p.brief.actorLook = 'long dark wavy hair, magenta patterned shirt'
    return p
  }
  it('composes action, place, extras, variety excluding the lead\'s look, camera grammar and look', () => {
    const prompt = shotPromptFor(hallwayPlan(), 1)
    expect(prompt).toMatch(/^she turns to camera holding the lipstick\./)
    expect(prompt).toMatch(/Place: busy school hallway\./)
    expect(prompt).toMatch(/Background: students walking past and chatting\./)
    expect(prompt).toMatch(/none of them has the lead's look \(long dark wavy hair, magenta patterned shirt\)/)
    expect(prompt).toContain(CAMERA_GRAMMAR.hook)
    expect(prompt).toMatch(/No CG effects, no added text\.$/)
  })
  it('a turn shot tells the model the movement never reverses', () => {
    const p = hallwayPlan()
    p.shots[5].action = 'she dances and spins all the way around in one direction, 360°'
    expect(shotPromptFor(p, 6)).toMatch(/one way only and completes; nothing reverses/)
    expect(shotPromptFor(p, 2)).not.toMatch(/nothing reverses/)
  })
  it('product macro shots never get a flat graphic background', () => {
    expect(shotPromptFor(hallwayPlan(), 3)).toMatch(/never a flat graphic background/)
  })
  it('warns when a public place has no extras', () => {
    const p = goodPlan()
    p.locations = ['school hallway', 'beach at golden hour']
    expect(validateTvcPlan(p).warnings.join(' | ')).toMatch(/"school hallway" is a public place; add extras/)
  })
  it('plain string locations still work (Review Focus 3)', () => {
    expect(locationName('beach')).toBe('beach')
    expect(shotPromptFor(goodPlan(), 2)).toMatch(/Place: beach at golden hour\./)
    expect(varietySentence()).not.toMatch(/lead's look \(/)
  })
  it('the shots slice carries the prompt', () => {
    const slice = sliceTvcPlan(hallwayPlan(), 'shots 1-1') as { shots: Array<{ prompt: string }> }
    expect(slice.shots[0].prompt).toMatch(/Background: students/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts`
Expected: FAIL, the exports are missing.

- [ ] **Step 3: Implement**

(`TURN_RE` comes from Task 5, in the same file.)

1. Replace `locations: z.array(z.string().min(1)),` with:

```ts
  locations: z.array(z.union([z.string().min(1), z.object({
    name: z.string().min(1),
    extras: z.string().optional().describe('Who is in the background, e.g. "students walking past and chatting"; required for public places'),
  })])),
```

2. Add `actorLook: z.string().optional().describe('The lead\'s look, e.g. "long dark wavy hair, magenta shirt"; extras never share it'),` to `brief`.

3. Add helpers:

```ts
type Loc = TvcPlan['locations'][number]
export const locationName = (loc: Loc): string => (typeof loc === 'string' ? loc : loc.name)
export const locationExtras = (loc: Loc): string | undefined => (typeof loc === 'string' ? undefined : loc.extras)
const PUBLIC_PLACE_RE = /\b(school|hallway|street|office|market|cafe|café|station|mall|park|restaurant|gym|campus|metro|bus)\b/i

export function varietySentence(actorLook?: string): string {
  return `The background people look clearly different from the lead: mixed hairstyles (short, curly, ponytails, buns), mixed clothing colours and builds${actorLook ? `, and none of them has the lead's look (${actorLook})` : ''}.`
}

// P4: camera grammar by shot type, composed in code rather than left to prose.
export const CAMERA_GRAMMAR: Record<TvcShot['type'], string> = {
  hook: 'An arresting first frame on a real lens, the brand visible.',
  reaction: 'Close on the face, shallow depth of field, a real moment of feeling.',
  hero: 'A composed shot on a real lens, the product held clearly, natural light.',
  lifestyle: 'A real place on a real lens, natural movement, depth in the background.',
  reach: 'A hand moving toward the product, cut before contact, shallow depth of field.',
  product_macro: 'Real lens, shallow depth of field, a slow rack focus, real surfaces and reflections; never a flat graphic background.',
  mechanism: 'A stylised but physical picture of how it works, with real materials.',
  superpower: "The product's feeling as a physical, filmable effect in a real place, no people.",
  packshot: 'The product as hero on a clean real set, with room for the end card, no text.',
}

export function shotPromptFor(plan: TvcPlan, n: number): string {
  const shot = plan.shots.find((s) => s.n === n)
  if (!shot) throw new Error('NO_SUCH_SHOT')
  const loc = shot.location !== undefined ? plan.locations[shot.location] : undefined
  const parts = [`${shot.action.replace(/\.+$/, '')}.`]
  if (TURN_RE.test(shot.action)) parts.push('Every movement goes one way only and completes; nothing reverses, rewinds or plays backwards.')
  if (loc) parts.push(`Place: ${locationName(loc)}.`)
  const extras = loc ? locationExtras(loc) : undefined
  if (extras) {
    parts.push(`Background: ${extras}.`)
    if (plan.brief.actorAvatarId) parts.push(varietySentence(plan.brief.actorLook))
  }
  parts.push(CAMERA_GRAMMAR[shot.type], `Look: ${plan.look}.`, 'No CG effects, no added text.')
  return parts.join(' ')
}
```

4. In `validateTvcPlan`, add to the warnings section:

```ts
  plan.locations.forEach((loc) => {
    if (PUBLIC_PLACE_RE.test(locationName(loc)) && !locationExtras(loc)) warnings.push(`"${locationName(loc)}" is a public place; add extras (who is in the background) so it does not look empty`)
  })
```

5. In the `shots a-b` slice mapping from Task 5, add `prompt: shotPromptFor(plan, s.n),`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check`

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts
git commit -m "feat(orchestrator): TVC shot prompts carry places, varied extras and camera grammar from code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: reference product type, reference cut times and `detect_cuts` (P5, P6)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts`, `tvcPlan.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/detectCuts.ts`, `detectCuts.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (both tool maps)

**Interfaces:**
- Consumes: Task 5's `brief.reference` and `brief.product`.
- Produces: plan errors `REFERENCE_PRODUCT_MISMATCH: ...` and a cut-times mismatch; tool `detect_cuts` (id `detect-cuts`); `export function parseShowinfoCuts(stderr: string): number[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tvcPlan.test.ts`:

```ts
describe('reference fidelity (P5, P6)', () => {
  it('P5: blocks a product whose type differs from the reference\'s', () => {
    const p = goodPlan()
    p.brief.reference = { productType: { material: 'glass', closure: 'crown cap', openedBy: 'bottle opener' } }
    p.brief.product = { material: 'plastic', closure: 'screw cap', openedBy: 'twist' }
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/REFERENCE_PRODUCT_MISMATCH: the reference uses a glass crown cap product opened with a bottle opener; this product is a plastic screw cap product opened with a twist/)
    p.brief.product = { material: 'glass', closure: 'Crown cap', openedBy: 'bottle opener' }
    expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/REFERENCE_PRODUCT_MISMATCH/)
    delete p.brief.product
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/REFERENCE_PRODUCT_MISMATCH: the reference uses a glass crown cap product/)
  })
  it('P6: shot boundaries must sit within 0.15s of the reference cuts', () => {
    const p = goodPlan()
    p.brief.reference = { cutTimes: [2, 4, 6, 7.5, 9.5, 12] }
    expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/reference/)
    p.brief.reference = { cutTimes: [2, 4.4, 6, 7.5, 9.5, 12] }
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/the cut after shot 2 is at 4s; the reference cuts at 4.4s/)
    p.brief.reference = { cutTimes: [2, 4] }
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/the reference has 2 cuts in 15s; this plan has 6/)
  })
})
```

Create `detectCuts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseShowinfoCuts } from './detectCuts.js'

describe('parseShowinfoCuts', () => {
  it('reads every pts_time from ffmpeg showinfo output, rounded, skipping 0', () => {
    const stderr = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  1 pts_time:1.6 duration\n[Parsed_showinfo_1 @ 0x1] n:   1 pts:  2 pts_time:3.68 x\n[x] pts_time:0\n'
    expect(parseShowinfoCuts(stderr)).toEqual([1.6, 3.68])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/detectCuts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `tvcPlan.ts`, add to `validateTvcPlan` before the warnings:

```ts
  // P5: a recreation copies the reference's product TYPE; only the brand changes.
  const refType = brief.reference?.productType
  if (refType) {
    const norm = (t: ProductType) => `${t.material}|${t.closure.trim().toLowerCase()}|${t.openedBy.trim().toLowerCase()}`
    const describe = (t: ProductType) => `a ${t.material} ${t.closure.trim().toLowerCase()} product opened with a ${t.openedBy.trim().toLowerCase()}`
    if (!brief.product || norm(brief.product) !== norm(refType)) {
      errors.push(`REFERENCE_PRODUCT_MISMATCH: the reference uses ${describe(refType)}; this product is ${brief.product ? describe(brief.product) : 'not described (set brief.product)'}. Copy the reference's product type and change only the brand`)
    }
  }
  // P6: when recreating, shot boundaries follow the reference's real cuts.
  const refCuts = (brief.reference?.cutTimes ?? []).filter((t) => t < length - EPS).sort((x, y) => x - y)
  if (refCuts.length) {
    const boundaries = starts.slice(1)
    if (boundaries.length !== refCuts.length) {
      errors.push(`the reference has ${refCuts.length} cuts in ${length}s; this plan has ${boundaries.length}`)
    } else {
      boundaries.forEach((b, i) => {
        if (Math.abs(b - refCuts[i]) > 0.15 + EPS) errors.push(`the cut after shot ${i + 1} is at ${b}s; the reference cuts at ${refCuts[i]}s`)
      })
    }
  }
```

Create `detectCuts.ts`:

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'

// Free: the real cut times of a reference ad (ffmpeg scene detection), so a
// recreation follows its edit rhythm instead of guessed timings (spec P6).
const execFile = promisify(execFileCb)
const MAX_SOURCE_BYTES = 300 * 1024 * 1024

export function parseShowinfoCuts(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100).filter((n) => n > 0)
}

export const detectCuts = createTool({
  id: 'detect-cuts',
  description: 'Free: finds the real cut times (scene changes) in a reference video, for recreating its edit timing. Write the result into the TVC plan as brief.reference.cutTimes.',
  inputSchema: z.object({
    videoFileId: z.string().describe('The reference video'),
    threshold: z.number().min(0.05).max(0.9).default(0.25).describe('Scene-change sensitivity; 0.25 matched the 2026-10-05 reference ad'),
  }),
  outputSchema: z.object({
    cutTimes: z.array(z.number()).optional(),
    durationSeconds: z.number().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { videoFileId, threshold } = inputData as { videoFileId: string; threshold: number }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined ?? 'unknown'
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    try {
      const url = await fetchPresignedUrl(videoFileId, idToken)
      const { filePath } = await downloadToSessionCache(tenantId || conversationId, videoFileId, url, MAX_SOURCE_BYTES)
      const { stderr } = await execFile('ffmpeg', ['-hide_banner', '-i', filePath, '-filter:v', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })
      const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 30_000 })
      return { cutTimes: parseShowinfoCuts(stderr), durationSeconds: Math.round(parseFloat(stdout.trim()) * 100) / 100 }
    } catch (err) {
      console.error('[detectCuts] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'DETECT_CUTS_FAILED' }
    }
  },
})
```

In `directorAgent.ts`:
- Add `import { detectCuts } from '../tools/detectCuts.js'`.
- Append `detect_cuts: detectCuts` to both tool maps after `check_still: checkStill`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/detectCuts.test.ts src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check`

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts apps/agent-orchestrator/src/mastra/tools/detectCuts.ts apps/agent-orchestrator/src/mastra/tools/detectCuts.test.ts apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): TVC recreations copy the reference's product type and real cut times

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `plan_tvc record` only accepts checked stills, and no stills for continuing shots

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/planTvc.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts`

**Interfaces:**
- Consumes: Task 4's `stillPassedCheck`; Task 5's `continuesFrom`.
- Produces:
  - `PlanTvcDeps.stillChecked: (stillFileId: string) => boolean`
  - a `records[]` item gains `keptByUser?: boolean`
  - refusals `STILL_NOT_CHECKED` and `CONTINUING_SHOT_HAS_NO_STILL`

- [ ] **Step 1: Write the failing tests**

In `planTvc.test.ts`, change `fakeDeps` so `opts` also takes `checked?: string[]`, and add to `deps`:

```ts
    stillChecked: (id) => (opts.checked ? opts.checked.includes(id) : true),
```

(Its signature becomes `function fakeDeps(opts: { slow?: boolean; checked?: string[] } = {})`.)

Append:

```ts
describe('record refuses unchecked stills (spec 3.3)', () => {
  it('STILL_NOT_CHECKED unless check_still passed or the user kept it', async () => {
    const { deps } = fakeDeps({ checked: ['ok1'] })
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 1, stillFileId: 'bad1' }] }, deps)).refusalReason).toMatch(/^STILL_NOT_CHECKED/)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 1, stillFileId: 'ok1' }] }, deps)).refused).toBeUndefined()
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 2, stillFileId: 'bad2', keptByUser: true }] }, deps)).refused).toBeUndefined()
  })
  it('a continuing shot takes no still', async () => {
    const { deps } = fakeDeps()
    const p = plan()
    p.shots[1].continuesFrom = 1
    p.shots[1].location = p.shots[0].location
    p.shots[1].size = 'close_up'
    const { planFileId, errors } = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(errors).toEqual([])
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 2, stillFileId: 's2' }] }, deps)).refusalReason).toMatch(/^CONTINUING_SHOT_HAS_NO_STILL/)
  })
})
```

(`plan()` is this file's existing 6s mood-ad helper. If its shot 1 and shot 2 sizes make the continuation invalid for another reason, adjust only the test's plan so the check passes, keeping `continuesFrom = 1`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/planTvc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `planTvc.ts`:

1. `PlanTvcDeps`: add `stillChecked: (stillFileId: string) => boolean`.

2. `records` item schema: add `keptByUser: z.boolean().optional().describe('The user chose to keep this still although its check failed')`. Also add a top-level `keptByUser: z.boolean().optional()` for the single-shot form, and push it in the single-shot branch: `records.push({ shot: input.shot, stillFileId: input.stillFileId, clipFileId: input.clipFileId, keptByUser: input.keptByUser })`.

3. After the existing `NARRATION_COUNT_MISMATCH` check, add:

```ts
  for (const r of records) {
    if (!r.stillFileId) continue
    const shot = doc.plan.shots.find((s) => s.n === r.shot)
    if (shot?.continuesFrom !== undefined) return { refused: true, refusalReason: `CONTINUING_SHOT_HAS_NO_STILL: shot ${r.shot} starts from shot ${shot.continuesFrom}'s last frame; record its clip only` }
    if (!r.keptByUser && !deps.stillChecked(r.stillFileId)) return { refused: true, refusalReason: `STILL_NOT_CHECKED: run check_still on shot ${r.shot}'s still first (or record it with keptByUser when the user chose to keep it)` }
  }
```

4. In the tool's `execute`, add to `deps`: `stillChecked: (id) => stillPassedCheck(conversationId, id),`. Import it: `import { stillPassedCheck } from './checkStill.js'`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/planTvc.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check`

```bash
git add apps/agent-orchestrator/src/mastra/tools/planTvc.ts apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts
git commit -m "feat(orchestrator): plan_tvc records only checked stills and no still for a continuing shot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: product-anchored video and plain content blocks (V1, V2)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`, `generateVideo.test.ts`
- Modify: `apps/inference-gateway/src/video.ts`, `video.test.ts`

**Interfaces:**
- Produces:
  - `videoItemSchema.productFileId?: string`, for `animate_frame` only
  - `export const PRODUCT_ANCHOR_PREFIX: string`
  - gateway: `export function isContentBlocked(message: string): boolean`; `generateVideo` returns `{ refused: true, reason: 'CONTENT_BLOCKED' }` on a content block, with no fallback attempt
  - orchestrator refusal text `CONTENT_BLOCKED: rephrase the shot (no ages or minors' activities)`

- [ ] **Step 1: Write the failing tests**

Append to `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts` (inside `describe('generateVideo tool', ...)`):

```ts
  it('anchors a product shot: start still first, product photo second, reference_to_video', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const m = String(url).match(/files\/([^/]+)\/presigned-url/)
      if (m) return new Response(JSON.stringify({ presignedUrl: `https://s3.example.com/${m[1]}.jpg` }), { status: 200 })
      return new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })
    })
    global.fetch = fetchSpy as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

    await generateVideo.execute!(
      { mode: 'animate_frame', prompt: 'she drinks. No one speaks.', aspectRatio: '16:9', durationSeconds: 3, startImageFileId: 'still1', productFileId: 'prod1' } as never,
      baseCtx(),
    )

    const genCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/v1/video/generations')) as unknown as [string, RequestInit]
    const body = JSON.parse(genCall[1].body as string)
    expect(body.task).toBe('reference_to_video')
    expect(body.imageUri).toBeUndefined()
    expect(body.referenceImageUris).toEqual(['https://s3.example.com/still1.jpg', 'https://s3.example.com/prod1.jpg'])
    expect(body.prompt.startsWith(PRODUCT_ANCHOR_PREFIX)).toBe(true)
  })

  it('rejects productFileId outside animate_frame', () => {
    expect(videoItemSchema.safeParse({ mode: 'text_to_video', prompt: 'x', aspectRatio: '16:9', durationSeconds: 3, productFileId: 'p' }).success).toBe(false)
  })

  it('turns a gateway CONTENT_BLOCKED refusal into a plain reason and refunds', async () => {
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] }) })
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'CONTENT_BLOCKED' }), { status: 200 })) as unknown as typeof fetch
    const r = await generateVideo.execute!({ mode: 'text_to_video', prompt: 'x', aspectRatio: '16:9', durationSeconds: 3 } as never, baseCtx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CONTENT_BLOCKED: rephrase the shot/) })
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refund' }))
  })
```

Update this file's import line to also import `videoItemSchema, PRODUCT_ANCHOR_PREFIX`.

Append to `apps/inference-gateway/src/video.test.ts` (inside the main `describe`):

```ts
  it('a Vertex content block is a plain CONTENT_BLOCKED refusal with no fallback call', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'The input could not be submitted. This input contains content that violates Google\'s Responsible AI practices.', code: 'content_blocked' } }), { status: 400 }))
    global.fetch = fetchSpy as unknown as typeof fetch
    const result = await generateVideo(req)
    expect(result).toEqual({ refused: true, reason: 'CONTENT_BLOCKED' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(vertexVideoBreaker.onFailure).not.toHaveBeenCalled()
  })
```

And a unit test for the helper (add `isContentBlocked` to that file's import):

```ts
describe('isContentBlocked', () => {
  it('matches Omni\'s content_blocked and Responsible AI messages only', () => {
    expect(isContentBlocked('Vertex Omni interactions failed: 400 {"error":{"code":"content_blocked"}}')).toBe(true)
    expect(isContentBlocked('violates Google\'s Responsible AI practices')).toBe(true)
    expect(isContentBlocked('Vertex Omni interactions failed: 500 boom')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/generateVideo.test.ts && pnpm --filter inference-gateway exec vitest run src/video.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement (gateway)**

In `apps/inference-gateway/src/video.ts`, add above `selectBackend`:

```ts
// Omni refuses some prompts outright (2026-10-05: "high-school girl … spin").
// The same prompt fails the same way on the API-key path, so this is never a
// reason to fall back or to count a backend failure: it is a plain refusal
// the agent can act on by rephrasing.
export function isContentBlocked(message: string): boolean {
  return /content_blocked|Responsible AI/i.test(message)
}
```

In `generateVideo`'s Vertex `catch (err)` block (the non-continuation one), make these the first lines:

```ts
        if (isContentBlocked((err as Error).message)) return { refused: true, reason: 'CONTENT_BLOCKED' }
```

Do the same in the Gemini-API-key `catch (err)` block and in the continuation `catch`, as their first lines. Make sure `VideoGenerationResult`'s refused shape (`{ refused: true; reason: string }`) covers it; it already does.

- [ ] **Step 4: Implement (orchestrator)**

In `generateVideo.ts`:

1. Add to `videoItemSchema`'s object (after `startImageFileId`):

```ts
  productFileId: z.string().optional().describe('animate_frame only: the product photo. The video is then anchored on [start still, product photo] so the product keeps its material, shape and label (Omni drifted glass to plastic from a start still alone, 2026-10-05)'),
```

and a refine:

```ts
).refine(
  (v) => v.productFileId === undefined || v.mode === 'animate_frame',
  { message: 'productFileId is only for animate_frame' },
```

2. Export the prefix:

```ts
export const PRODUCT_ANCHOR_PREFIX = 'The first image is the exact opening frame and scene. The second image is the exact product; it stays unchanged and visible — same material, shape, closure and label — the whole time. '
```

3. Destructure `productFileId`. In the `animate_frame` resolution, after `imageUri` is resolved:

```ts
      if (mode === 'animate_frame' && inputData.productFileId && imageUri) {
        try {
          referenceImageUris = [imageUri, await fetchPresignedUrl(inputData.productFileId, idToken)]
          imageUri = undefined
        } catch (err) {
          console.error(`[session:${sessionId}] generateVideo: failed to resolve product image ${inputData.productFileId}:`, (err as Error).message)
          return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE', jobId }
        }
      }
```

4. Change the `task` line to:

```ts
    const task = mode === 'text_to_video' ? 'text_to_video' : (mode === 'composite_references' || referenceImageUris?.length) ? 'reference_to_video' : 'image_to_video'
```

and compute the sent prompt as `const sentPrompt = referenceImageUris?.length && mode === 'animate_frame' ? PRODUCT_ANCHOR_PREFIX + prompt : prompt`. Use `sentPrompt` in the gateway body instead of `prompt`.

5. In the `if (genResult.refused)` block, map the reason:

```ts
      const reason = genResult.reason === 'CONTENT_BLOCKED' ? "CONTENT_BLOCKED: rephrase the shot (no ages or minors' activities)" : (genResult.reason ?? 'unknown')
      return { refused: true, refusalReason: reason, jobId }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/generateVideo.test.ts src/mastra/tools/generateVideos.test.ts && pnpm --filter inference-gateway test`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check && pnpm --filter inference-gateway exec tsc --noEmit`

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts apps/inference-gateway/src/video.ts apps/inference-gateway/src/video.test.ts
git commit -m "feat(video): product shots anchor on the product photo; content blocks are plain refusals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: text and end card stay off faces (O1)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/overlayText.ts`, `overlayText.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts`, `compositeEndCard.test.ts`

**Interfaces:**
- Consumes: Task 2's `faceBoxes`, `chooseTextPosition`, `chooseCardColumn`, `gatewayAsk`, `sampleFrames`.
- Produces:
  - `overlay_text` input `avoidFaces?: boolean`; output `positions?: string[]`; export `applyFacePlacement(overlays, facesPerOverlay): TextOverlay[]`
  - `composite_end_card` input `avoidFaces?: boolean`; export `cardOverlayX(column: 'center' | 'left' | 'right'): string`

- [ ] **Step 1: Write the failing tests**

Append to `overlayText.test.ts`:

```ts
import { applyFacePlacement } from './overlayText.js'

describe('avoidFaces placement (O1)', () => {
  it('moves an overlay off a face and shrinks when no band is free', () => {
    const out = applyFacePlacement(
      [{ text: 'bubbli', startSeconds: 12, endSeconds: 14.8, position: 'center', size: 'large' }, { text: 'hi', startSeconds: 0, endSeconds: 1, position: 'top' }],
      [[{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }], [{ x0: 0, y0: 0, x1: 1, y1: 1 }]],
    )
    expect(out[0]).toMatchObject({ position: 'top', size: 'large' })
    expect(out[1]).toMatchObject({ position: 'top', size: 'small' })
  })
  it('keeps the requested placement when face detection gave nothing (Review Focus 5)', () => {
    const out = applyFacePlacement([{ text: 'x', startSeconds: 0, endSeconds: 1, position: 'bottom' }], [null])
    expect(out[0].position).toBe('bottom')
  })
})
```

Append to `compositeEndCard.test.ts`:

```ts
import { cardOverlayX } from './compositeEndCard.js'

describe('end card column (O1)', () => {
  it('centre, or a side third clear of the face', () => {
    expect(cardOverlayX('center')).toBe('(W-w)/2')
    expect(cardOverlayX('left')).toBe('W*0.04')
    expect(cardOverlayX('right')).toBe('W-w-W*0.04')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts src/mastra/tools/compositeEndCard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `overlay_text`**

In `overlayText.ts`:

1. Imports: `import { chooseTextPosition, faceBoxes, gatewayAsk, sampleFrames, type Box } from './tvcChecks.js'`.

2. Add:

```ts
/** O1: per overlay, the faces found in its window (null = detection failed → keep the request). */
export function applyFacePlacement(overlays: TextOverlay[], facesPerOverlay: Array<Box[] | null>): TextOverlay[] {
  return overlays.map((o, i) => {
    const faces = facesPerOverlay[i]
    if (!faces) return o
    const { position, shrink } = chooseTextPosition(faces, o.position)
    return { ...o, position, ...(shrink ? { size: 'small' as const } : {}) }
  })
}
```

3. `inputSchema`: add `avoidFaces: z.boolean().optional().describe('Keep the text off faces: finds faces in each overlay\'s time window and moves it to a clear band (TVC tagline and end card)'),`. `outputSchema`: add `positions: z.array(z.string()).optional(),`.

4. In `execute`, after the source is downloaded and before charging:

```ts
    let placed = overlays
    if ((inputData as { avoidFaces?: boolean }).avoidFaces) {
      const faceDir = mkdtempSync(join(tmpdir(), 'overlay-faces-'))
      try {
        const ask = gatewayAsk(tenantId)
        const faces = await Promise.all(overlays.map(async (o) => {
          try {
            const [frame] = await sampleFrames(videoPath, [Math.round(((o.startSeconds + o.endSeconds) / 2) * 100) / 100], faceDir)
            return await faceBoxes(ask, frame)
          } catch {
            return null
          }
        }))
        placed = applyFacePlacement(overlays, faces)
      } finally {
        rmSync(faceDir, { recursive: true, force: true })
      }
    }
```

Use `placed` instead of `overlays` where the ASS file is built (`buildAss(placed)`), and add `positions: placed.map((o) => o.position)` to the success return.

- [ ] **Step 4: Implement `composite_end_card`**

In `compositeEndCard.ts`:

1. Imports: `import { chooseCardColumn, faceBoxes, gatewayAsk, sampleFrames } from './tvcChecks.js'`.

2. Add and export:

```ts
export function cardOverlayX(column: 'center' | 'left' | 'right'): string {
  return column === 'left' ? 'W*0.04' : column === 'right' ? 'W-w-W*0.04' : '(W-w)/2'
}
```

3. `inputSchema`: add `avoidFaces: z.boolean().optional().describe('When a person is on the last frame, shrink the card to a third and put it beside them, never over a face'),`.

4. After `dissolveStart` and the video size are computed, before building `filterComplex`:

```ts
      let column: 'center' | 'left' | 'right' = 'center'
      let cardScale = `${videoWidth}:${videoHeight}`
      if ((inputData as { avoidFaces?: boolean }).avoidFaces) {
        try {
          const [frame] = await sampleFrames(videoPath, [Math.min(clipDurationSeconds - 0.05, dissolveStart + 0.2)], workDir)
          const faces = await faceBoxes(gatewayAsk(tenantId), frame)
          if (faces.length) {
            column = chooseCardColumn(faces)
            cardScale = `${Math.round(videoWidth / 3)}:${Math.round(videoHeight * 0.8)}`
          }
        } catch (err) {
          console.warn(`[session:${sessionId}] compositeEndCard: face check failed, keeping the centred card:`, (err as Error).message)
        }
      }
```

Change the `filterComplex` to use `scale=${cardScale}:force_original_aspect_ratio=decrease` and `overlay=${cardOverlayX(column)}:(H-h)/2`.

(Use the variable name this file already uses for its temp dir if it isn't `workDir`.)

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts src/mastra/tools/compositeEndCard.test.ts`
Expected: PASS (existing tests unchanged: `avoidFaces` defaults to off).

- [ ] **Step 6: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check`

```bash
git add apps/agent-orchestrator/src/mastra/tools/overlayText.ts apps/agent-orchestrator/src/mastra/tools/overlayText.test.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts
git commit -m "feat(orchestrator): on-screen text and the end card keep off faces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: the TVC skill texts point at the tools (additive)

**Files:**
- Modify: `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md` (append only)
- Modify: `products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md` (append only)
- Test: `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts`

**Interfaces:**
- Consumes: every tool name and field from Tasks 1–10: `check_still`, `detect_cuts`, the slice fields `prompt`, `generateSeconds`, `startFromPreviousLastFrame`, `trimStartSeconds`, `trimToEnd`, the `check_clip` inputs, `productFileId` on `generate_video`, `avoidFaces`, `keptByUser`, `roomTone`.

- [ ] **Step 1: Write the failing test** (inside the existing tvc-ad test, after its last `expect`)

```ts
    expect(director).toMatch(/Quality tools \(supersede the matching lines above\)/)
    expect(director).toContain('check_still')
    expect(director).toContain('detect_cuts')
    expect(director).toMatch(/generateSeconds/)
    expect(director).toMatch(/trimStartSeconds/)
    expect(director).toMatch(/productFileId/)
    expect(director).toMatch(/avoidFaces true/)
    expect(director).toMatch(/keptByUser/)
    expect(director).toMatch(/roomTone true/)
    expect(director).toMatch(/one direction and complete/)
    expect(card).toMatch(/Reference video: <fileId>/)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: FAIL.

- [ ] **Step 3: Append to `tvc-ad/director.md`** (do not edit any existing line):

```markdown

Quality tools (supersede the matching lines above):
- step plan: give every shot an angle (eye, low, high, top, side or pov). Write every turn as one direction and complete ("spins all the way around in one direction, 360°"). Give an endState to every action that changes an object (open, pop, pour, bite, apply, peel, unwrap, cut). Give continuesFrom to a shot that continues the previous shot's action at the same place. Write each place as {name, extras}, with extras (who is in the background) for any public place. Write brief.actorLook when the plan has an actor. Keep a hard action in ONE shot. Split it only into a clearly different angle AND size, and use flashCut only for a deliberate flash cut. plan_tvc enforces the rest.
- Recreating a reference ad: Olmo's brief has "Reference video: <fileId>". Call detect_cuts on it and write brief.reference.cutTimes. Write brief.reference.productType (material, closure, openedBy) from what the reference shows, and brief.product the same way for the user's product. If they differ, plan_tvc refuses; tell Olmo the reference's product type so the user can match it.
- step stills: after each still, call check_still:
  - productFileId whenever the product is visible
  - productScale: wide for a wide shot, medium for a medium shot, otherwise close
  - productMustBeVisible = the shot's productVisible
  - expectExtras when the shot's place has extras
  - actorFileId = the avatar, and leadInShot when the actor is in the shot

  On a fail, generate that still once more with the check's reason added to the prompt and check again. On a second fail, record nothing for it and return the still and the reason to Olmo. Record a still only after it passed, or with keptByUser true when Olmo says the user kept it. A shot with startFromPreviousLastFrame gets no still.
- step clips: use each shot's slice:
  - prompt: it already carries the place, the background people, the camera grammar and the look; add only "No one speaks" or the quoted line
  - durationSeconds = generateSeconds
  - productFileId = the product photo for every shot with the product visible, so the video keeps its material and label
  - startFromPreviousLastFrame: when true, extract_frame "last" of the previous shot's recorded clip and use that image as the start frame
- check_clip for every TVC clip, in addition to the inputs above: productMustBeVisible (the shot's productVisible), productScale, productExpectedState (the shot's endState when the action changes the product), expectExtras, leadFileId (the avatar) when the plan has an actor, action, endState, shotDurationSeconds. A check that comes back CHECK_UNAVAILABLE is not a pass: return the clip to Olmo as unchecked.
- trim_clip: startSeconds = check_clip's trimStartSeconds (centred on the action) when it returned one. Otherwise use the slice's trimStartSeconds: 0 for a continuing shot. When the slice says trimToEnd, end the trim at the clip's end (startSeconds = clip length minus the shot's durationSeconds), so the next shot continues from its real last frame.
- A video refused with CONTENT_BLOCKED: rewrite that shot without ages or minors' activities ("a young woman", not "a high-school girl") and try it once more; that refused attempt was refunded.
- step finish: assemble_clips with roomTone true. overlay_text with avoidFaces true. composite_end_card with avoidFaces true.
```

- [ ] **Step 4: Append to `tvc-ad.md`** (do not edit any existing line):

```markdown
12. Recreating a reference ad: when the user gives a reference ad to copy, pass "Reference video: <fileId>" in the "step: plan" delegation. If Director reports that the reference uses a different product type (for example a glass bottle with a crown cap opened on an opener), tell the user in one plain sentence and ask for a matching product photo or permission to change the action.
13. Stills that fail their check: Director returns them with the reason. Show the still with the problem in one plain sentence and ask: redo it, or keep it? Keeping it means telling Director "keep still <n>" (it records it as kept); a redo is "step: redo still <n>".
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts && pnpm --filter agent-orchestrator test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts
git commit -m "feat(skills): TVC Director rules point at the quality tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: regression fixtures on the real check model, and final verification

**Files:**
- Create: `apps/agent-orchestrator/test-fixtures/tvc/` with `cap-stays-on.mp4`, `lookalike-extra.mp4`, `single-shot-pop.mp4`, `lead.jpg`, `product.jpg`
- Create: `apps/agent-orchestrator/src/mastra/tools/tvcChecks.regression.test.ts`

**Interfaces:**
- Consumes: Task 2's `runNarrowClipChecks`, `sampleFrames`, `AskFn`.

- [ ] **Step 1: Copy the fixtures** (each under ~2 MB; re-encode to 720p, keeping full resolution for the checks)

```bash
S=/private/tmp/claude-501/-Users-suyash-Desktop-projects-01-products-project-context/35e0c8c0-e545-4da2-90e3-dd6027594def/scratchpad/coke
F=apps/agent-orchestrator/test-fixtures/tvc
mkdir -p $F
ffmpeg -loglevel error -y -i $S/k5.mp4 -vf scale=-2:720 -c:v libx264 -crf 28 -an $F/cap-stays-on.mp4
ffmpeg -loglevel error -y -i $S/k10_flagged.mp4 -vf scale=-2:720 -c:v libx264 -crf 28 -an $F/lookalike-extra.mp4
ffmpeg -loglevel error -y -i $S/k5s.mp4 -vf scale=-2:720 -c:v libx264 -crf 28 -an $F/single-shot-pop.mp4
ffmpeg -loglevel error -y -i $S/actor.png -vf scale=-2:720 -q:v 3 $F/lead.jpg
ffmpeg -loglevel error -y -i $S/bottle.png -vf scale=-2:720 -q:v 3 $F/product.jpg
ls -la $F
```

Expected: five files, each under 2 MB. If a source file is missing, stop and report it. Do not substitute a different clip.

- [ ] **Step 2: Write the tagged regression suite**

Create `tvcChecks.regression.test.ts`:

```ts
// Real gemini-2.5-pro on the 2026-10-05 failing and passing clips. Tagged:
// runs only with RUN_TVC_REGRESSION=1 (needs gcloud access to the project).
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runNarrowClipChecks, sampleFrames, type AskFn, type Img } from './tvcChecks.js'

const FIX = join(__dirname, '../../../test-fixtures/tvc')
const PROJECT = process.env.TVC_REGRESSION_PROJECT ?? 'excellent-setup-486815-c1'
const ACCOUNT = process.env.TVC_REGRESSION_ACCOUNT ?? 'suyashresearchwork@gmail.com'
const jpg = (f: string): Img => ({ data: readFileSync(join(FIX, f)).toString('base64'), mime: 'image/jpeg' })
const duration = (f: string) => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${join(FIX, f)}`).toString())

// Vertex directly (no gateway needed): same model, same JSON contract.
const vertexAsk: AskFn = async (parts) => {
  const token = execSync(`gcloud auth print-access-token --account=${ACCOUNT}`).toString().trim()
  const body = { contents: [{ role: 'user', parts: parts.map((p) => ('text' in p ? { text: p.text } : { inlineData: { mimeType: p.image.mime, data: p.image.data } })) }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }
  const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-2.5-pro:generateContent`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const v = JSON.parse(json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
  return Array.isArray(v) ? v[0] : v
}

describe.skipIf(!process.env.RUN_TVC_REGRESSION)('TVC checks on real clips (gemini-2.5-pro)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvc-reg-'))
  const sampler = (f: string) => (times: number[]) => sampleFrames(join(FIX, f), times, dir)

  it('C7: the opener whose cap stays on fails ACTION_NOT_COMPLETED', async () => {
    const r = await runNarrowClipChecks(vertexAsk, sampler('cap-stays-on.mp4'), { duration: duration('cap-stays-on.mp4'), action: 'the crown cap pops off the bottle on the wall opener', endState: 'the bottle has no cap on it' })
    expect(r.passed).toBe(false)
    expect(r.endStateTrue).toBe(false)
  }, 300_000)

  it('C6: the wide shot with a lookalike extra fails LEAD_CLONED', async () => {
    const r = await runNarrowClipChecks(vertexAsk, sampler('lookalike-extra.mp4'), { duration: duration('lookalike-extra.mp4'), lead: jpg('lead.jpg') })
    expect(r.leadClone).toBe(true)
    expect(r.passed).toBe(false)
  }, 300_000)

  it('C7: the single-shot pop passes with the action located', async () => {
    const r = await runNarrowClipChecks(vertexAsk, sampler('single-shot-pop.mp4'), { duration: duration('single-shot-pop.mp4'), action: 'the crown cap pops off the bottle on the wall opener', endState: 'the bottle has no cap on it', shotDurationSeconds: 0.88 })
    expect(r.endStateTrue).toBe(true)
    expect(r.actionTime).not.toBeNull()
    expect(r.trimStartSeconds).toBeGreaterThanOrEqual(0)
  }, 300_000)
})
```

- [ ] **Step 3: Run the suite against the real model**

Run: `RUN_TVC_REGRESSION=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcChecks.regression.test.ts`
Expected: 3 PASS.
- If the default suite is run without the env var, the suite is skipped.
- If a case fails because the model misjudged, **do not loosen the assertion**. Report the verdict and the frames in your report, so the controller can decide whether the question wording needs to change.

- [ ] **Step 4: Final verification**

Run:

```bash
pnpm --filter agent-orchestrator test
pnpm --filter agent-orchestrator type-check
pnpm --filter inference-gateway test
pnpm --filter @serverless-saas/agent-api test
RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/assembleClips.realffmpeg.test.ts
```

Expected:
- All pass, except the known pre-existing `personas.test.ts` failure in agent-api (untouched by this branch).
- The real-ffmpeg join is 24fps, with its length within 0.1s of the sum.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/test-fixtures/tvc apps/agent-orchestrator/src/mastra/tools/tvcChecks.regression.test.ts
git commit -m "test(orchestrator): TVC check regressions on the real failing and passing clips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deploy (after merge; done by the user, not by an implementer)

1. Orchestrator: `pm2 restart` it (`./deploy.sh` does not).
2. Gateway: `pm2 restart inference-gateway` (V2).
3. Official-skills seed: run it for the `director.md` and `tvc-ad.md` changes, then check the DB row's latest version.
4. No migration; no new credit rates (checks are free; `detect_cuts` and `check_still` are free).
5. Live test: remake the Bubbli recreation through the product on the VM and compare it with the approved v5 (`~/Desktop/coke-recreation-test/7-BUBBLI-TVC-v5.mp4`), using the spec §6 pass criteria.

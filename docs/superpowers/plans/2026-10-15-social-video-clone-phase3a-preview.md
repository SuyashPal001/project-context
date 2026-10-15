# Social video clone — Phase 3a: remake plan, casting, checked stills, free preview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a measured breakdown and the user's brand, a Mastra workflow writes a keep/swap/drop remake plan, casts a new person (user picks 1 of 3), makes every look's start (and end) still with checks before and after each paid call, and renders a FREE still-by-still preview, so no clip money is spent until the user has seen the whole remake.

**Architecture:** A Mastra workflow `videoRemake` (steps plan → cast → stills → preview) suspends for the plan review and for the cast pick. It runs on a PRIVATE Mastra instance that shares the Postgres store but is never mounted on the unauthenticated `/studio` API. One agent tool, `remake_video`, starts and resumes runs. It checks run ownership (tenant and conversation) and asks for generation approval before each paid stage. Every paid image goes through the prompt gate, then generation, then the still checks (glitches, same face, measured pose vs the reference's measured pose), with one automatic retry; every attempt is written to a cost ledger.

**Tech Stack:** Mastra 1.64 workflows (suspend/resume, `getWorkflowRunById`), `@mastra/core/storage` InMemoryStore in tests, zod, vitest; ai-service FastAPI + rtmlib (RTMPose) for still body reading; system ffmpeg for crops and the preview.

**Spec:** `docs/superpowers/specs/2026-10-14-social-video-clone-design.md` (§3 flow, §5.3–5.4, §6.2, §7, §8, §8a). Phase 3 is split (user decision 2026-10-15): **3a = this plan**; 3b = clips (Veo first+last + Omni), retry cap on clips, joining, music, final checks; 3c = trick recipes that need filmed plates.

## Global Constraints

- **Money safety (§8a):** no paid call from a model's guess. Every paid image call is preceded by the prompt gate (`promptCheckScorer` via `runGate`); a gate result of `fail` OR `unknown` blocks the call (unknown is never a pass).
- **One automatic retry** per failed still, with the check's reasons added; on a second failure, stop and report that item. Never retry on `unknown` (never auto-fix from an unverified claim, §8).
- **Prompts come from plan lines** (rule 7.2), built by code (`remake/prompts.ts`), never written freehand by the agent.
- **Add nothing the reference doesn't have** (7.1); **directions are image-left/right** (7.6); **pose from pictures** (7.4): the reference frame is a pose-only guide.
- **Never copy:** the music, a real person's face, logos, verbatim script, or the reference's on-screen text. The cast is always a new person. No real person's or character's name appears in a plan line or a prompt.
- **Measured, not guessed:** look spans come from `breakdown.pose.looks` when measured; a breakdown with `watch_only: true`, or with no body readings (`pose === null`), is refused before any spend.
- **Reel can be anything:** nothing here may assume the fan reel. No-person looks, many-people looks, and talking-head framing must all flow through (a no-person look gets no casting and a layout-only guide).
- **User-facing text:** plain outcome words; never "download", "server", "Gemini", "ai-service", "gateway", "yt-dlp", or provider names. Real errors go to `console.error('[remake] …')`.
- **Tenancy:** a run is bound to `{tenantId, conversationId}` at start; every resume checks both against the caller's request context. Charges use the caller's request-context tenant only.
- **No new UI:** choices go through the agent in chat (agentic-first).
- **Mastra-native:** workflow suspend/resume and stored run state, not a hand-built state table.
- `*.md` is gitignored in this repo: plans, docs and skill files are committed with `git add -f`.
- Charge keys must stay short: the workflow passes `agent.toolCallId = "remake:<runId>"`; `generateImageItem` already hashes it via `stableToolCallId`.

## Review Focus

1. **Second Mastra instance on the same Postgres store**: both instances `init` the store, and snapshots written by one must be readable by the other. Expect a remake run to survive an orchestrator restart (Task 10 adds a test that re-creates the instance on the same store and resumes; the live smoke in Task 12 resumes after `pm2 restart`).
2. **A resume from a different conversation or tenant** (a guessed or leaked `runId`): expect `not_found`, with no spend and no detail (Task 11 test).
3. **A reel with no person at all** (product-only): expect no cast step, a layout-only guide prompt with no person sentence, and the pose check passing when the still also has nobody in it (Tasks 5, 7 and 10 tests).
4. **Insufficient credits mid-run**: expect the remaining stills to stop being paid, failed items listed plainly, and the preview still rendered with grey cards for missing looks (Tasks 8 and 9 tests).
5. **The user edits the plan to re-introduce a forbidden thing** (keeps the music, keeps the reference's on-screen text, removes the cast swap): expect the rule enforcement to override it and say so in `warnings` (Task 3 test).

---

## File Structure

New directory `apps/agent-orchestrator/src/mastra/remake/` (product code, video-clone only):

| File | Responsibility |
|---|---|
| `types.ts` | Shared shapes: `Brand`, `PlanLine`, `RemakeLook`, `RemakePlan`, `LedgerEntry`, `StillResult`, `ImagePose` |
| `looks.ts` | `remakeLooks(breakdown)`, `refuseReason(breakdown)`, `personIn(look)`, `bodyChanged(a, b)` |
| `plan.ts` | `planRefs`, `enforceRules`, `applyEdits`, `writePlan` (one checked model call) |
| `cost.ts` | `estimateCost`, `ledgerSummary` |
| `prompts.ts` | `castSheetPrompt`, `stillPrompt`, `stillGateInput` |
| `poseCompare.ts` | `comparePose(ref, refPeople, got)`: measured pose check |
| `paidStill.ts` | `makeStill`: gate → generate → check → one retry, with ledger |
| `preview.ts` | `previewSegments`, `renderPreview` (ffmpeg) |
| `deps.ts` | `RemakeDeps` interface, `defaultDeps()`, `setRemakeDeps()` for tests |
| `workflow.ts` | `videoRemakeWorkflow`: plan, cast, stills and preview steps |
| `instance.ts` | private Mastra instance: `remakeWorkflow()`, `setRemakeStorageForTests()` |
| `remakeVideoTool.ts` | the `remake_video` agent tool |

Modified:
- `apps/ai-service/media/pose.py` and `media/router.py`: add `read_image` and the `/media/pose-image` route.
- `tools/videoBreakdown/aiServiceClient.ts`: add `/media/pose-image` to the route union.
- `tools/videoBreakdown/measuredLine.ts`: export `personWords`.
- `scorers/video/promptCheck.ts`: the invented bullet also names real people and characters.
- `agents/platformAgent.ts`, `agents/directorAgent.ts`: register `remake_video`.
- `__tests__/serverTools.test.ts` and `__tests__/studioWorkflows.test.ts`.
- `products/agent-platform/packages/api/seeds/official-skills/template-video.md`: append step 8.
- `docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md`: add a Phase 3a section.

All orchestrator test commands run from `apps/agent-orchestrator`: `npx vitest run <path>`. All ai-service test commands run from `apps/ai-service`: `.venv/bin/pytest <path> -q`.

---

### Task 1: ai-service still body reading (`/media/pose-image`)

**Files:**
- Modify: `apps/ai-service/media/pose.py` (extract `_persons`, add `read_image`)
- Modify: `apps/ai-service/media/router.py` (route)
- Modify: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/aiServiceClient.ts` (route union + `ImagePose` type)
- Test: `apps/ai-service/tests/test_pose_image.py`

**Interfaces:**
- Produces: `POST /media/pose-image {path}` returns `{"model": str, "people": int, "no_person": bool, "main": BodyReading-without-frames | null}`, where `main` is `read_person(...)` of the largest person. TS: `export interface ImagePose { model: string; people: number; no_person: boolean; main: Omit<BodyReading, 'frames'> | null }`.

- [ ] **Step 1: Write the failing tests**

```python
# apps/ai-service/tests/test_pose_image.py
# Still body reading: the same general reading as video looks, for ONE image.
import numpy as np
import cv2
from media import pose
from test_pose_general import person

H = {"x-internal-service-key": "k"}

class FakeDet:
    def __init__(self, boxes): self.boxes = boxes
    def __call__(self, img): return np.asarray(self.boxes, dtype=float)

class FakePose:
    def __init__(self, people): self.people = people  # list of (kp fractions, scores)
    def __call__(self, img, bboxes):
        h, w = img.shape[:2]
        kps = np.stack([kp * np.array([w, h]) for kp, _ in self.people[: len(bboxes)]])
        scs = np.stack([sc for _, sc in self.people[: len(bboxes)]])
        return kps, scs

def _img(tmp_path, name="still.jpg"):
    p = tmp_path / name
    cv2.imwrite(str(p), np.full((200, 100, 3), 128, np.uint8))
    return p

def test_one_standing_person_reads_full_body_upright(tmp_path, monkeypatch):
    kp, sc = person()
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 10, 90, 190]]), FakePose([(kp, sc)])))
    d = pose.read_image(str(_img(tmp_path)))
    assert d["people"] == 1 and d["no_person"] is False
    assert d["main"]["orientation"] == "vertical" and d["main"]["knees"] == "straight"

def test_no_detection_is_no_person_not_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet(np.zeros((0, 4))), FakePose([])))
    d = pose.read_image(str(_img(tmp_path)))
    assert d == {"model": pose.MODEL_NAME, "people": 0, "no_person": True, "main": None}

def test_main_person_is_the_largest(tmp_path, monkeypatch):
    big, sc = person(); small, sc2 = person(knee=(70, 70))
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[40, 40, 60, 80], [5, 5, 95, 195]]), FakePose([(small, sc2), (big, sc)])))
    d = pose.read_image(str(_img(tmp_path)))
    assert d["people"] == 2 and d["main"]["knees_toward"] == "center"

def test_route_rejects_an_unreadable_image(client, media_dir):
    p = media_dir / "bad.jpg"; p.write_bytes(b"not an image")
    r = client.post("/media/pose-image", json={"path": str(p)}, headers=H)
    assert r.status_code == 400
```

- [ ] **Step 2: Run them to verify they fail**

Run: `.venv/bin/pytest tests/test_pose_image.py -q`
Expected: FAIL with `AttributeError: module 'media.pose' has no attribute 'read_image'`.

- [ ] **Step 3: Implement.** In `media/pose.py`, add `_persons` above `measure_pose` and use it inside `measure_pose`, replacing the inline `boxes = …` through the `persons.append(...)` loop; the behaviour is unchanged. Then add `read_image`:

```python
def _persons(img, det, pose_model):
    """[(kp 17x2 fractions, scores 17, box fractions)] for every person worth counting in one frame."""
    h, w = img.shape[:2]
    boxes = [b for b in np.asarray(det(img)).reshape(-1, 4) if _box_area((b[0] / w, b[1] / h, b[2] / w, b[3] / h)) >= MIN_BOX_AREA]
    persons = []
    if boxes:
        kps, scs = pose_model(img, bboxes=[list(map(float, b)) for b in boxes])
        for kp, sc, b in zip(kps, scs, boxes):
            if int((sc >= VIS).sum()) >= MIN_JOINTS:
                persons.append((kp / np.array([w, h]), sc, (b[0] / w, b[1] / h, b[2] / w, b[3] / h)))
    return persons


def read_image(path: str) -> dict:
    """The same general body reading as a look, for one still (a generated remake frame)."""
    img = cv2.imread(path)
    if img is None:
        raise ValueError("unreadable image")
    det, pose_model = _load()
    h, w = img.shape[:2]
    persons = _persons(img, det, pose_model)
    if not persons:
        return {"model": MODEL_NAME, "people": 0, "no_person": True, "main": None}
    main = max(persons, key=lambda p: _box_area(p[2]))
    return {"model": MODEL_NAME, "people": len(persons), "no_person": False, "main": read_person(main[0], main[1], h / w, main[2])}
```

`measure_pose` after the change (only the body of the per-frame block changes):

```python
        h, w = img.shape[:2]
        aspect = h / w
        persons = _persons(img, det, pose_model)
        frames.append((t, persons))
```

In `media/router.py`, after `post_pose`:

```python
@router.post("/pose-image")
def post_pose_image(body: PathBody):
    try:
        return pose.read_image(str(safe_media_path(body.path)))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

In `aiServiceClient.ts`, add `'/media/pose-image'` to the `route` union and append:

```ts
export interface ImagePose { model: string; people: number; no_person: boolean; main: Omit<BodyReading, 'frames'> | null }
```

- [ ] **Step 4: Run them to verify they pass, plus the existing pose tests**

Run: `.venv/bin/pytest tests/test_pose_image.py tests/test_pose.py tests/test_pose_general.py -q`
Expected: all pass. (`test_pose_golden.py` needs `GOLDEN_VIDEOS_DIR`; run it too when `/tmp/claude-501/golden` exists: `GOLDEN_VIDEOS_DIR=/tmp/claude-501/golden .venv/bin/pytest tests/test_pose_golden.py -q`, which should still be 6/6.)

- [ ] **Step 5: Commit**

```bash
git add apps/ai-service/media/pose.py apps/ai-service/media/router.py apps/ai-service/tests/test_pose_image.py apps/agent-orchestrator/src/mastra/tools/videoBreakdown/aiServiceClient.ts
git commit -m "feat(ai-service): /media/pose-image reads one still's people and body the same way as a look"
```

---

### Task 2: Remake looks and refusals (`types.ts`, `looks.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/types.ts`
- Create: `apps/agent-orchestrator/src/mastra/remake/looks.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/looks.test.ts`

**Interfaces:**
- Consumes: `Breakdown` (`tools/videoBreakdown/breakDownVideo.ts`), `lookSpans`, `BodyReading`, `ImagePose` (Task 1).
- Produces: every type below, plus `remakeLooks(b: Breakdown): RemakeLook[]`, `refuseReason(b: Breakdown): string | null`, `personIn(l: RemakeLook): boolean`, `bodyChanged(a, b): boolean`, `aspectOf(b): '9:16' | '16:9' | '1:1'`.

- [ ] **Step 1: Write `types.ts`** (types only, no test of its own)

```ts
// apps/agent-orchestrator/src/mastra/remake/types.ts
import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
export type { ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'

export interface Brand { name: string; product: string; productPhotoFileId?: string; audience?: string; notes?: string }

/** One element of the breakdown and what the remake does with it (spec §6.2). */
export interface PlanLine { ref: string; action: 'keep' | 'swap' | 'drop'; to?: string; why?: string; auto?: boolean }

export interface RemakeLook {
  n: number                       // 1-based; ref index is n - 1 (overview.looks order)
  label: string; startS: number; endS: number
  outfit: string; expression: string; startPose: string; endPose: string
  measured: string | null         // the breakdown's plain "Measured:" line
  people: number | null; noPerson: boolean | null
  start: BodyReading | null; end: BodyReading | null
  moves: number
  guideStartS: number; guideEndS: number   // measured frames used as pose-only guides
  needsEndStill: boolean
}

export interface RemakeReference {
  setting: string
  props: Array<{ prop: string; where: string; when: string }>
  moments: Array<{ t_s: number; what: string }>
  musicMood: string
  videoFileId: string
  durationS: number; width: number; height: number
}

export interface RemakePlan {
  lines: PlanLine[]; looks: RemakeLook[]; reference: RemakeReference
  needsCasting: boolean; aspectRatio: '9:16' | '16:9' | '1:1'; warnings: string[]
}

export interface LedgerEntry { item: string; attempt: number; creditsMicro: string; outcome: 'kept' | 'retried' | 'failed' | 'blocked' }
export interface StillResult { look: number; kind: 'start' | 'end'; fileId: string | null; status: 'passed' | 'failed' | 'unchecked' | 'blocked'; reasons: string[] }
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/looks.test.ts
import { describe, it, expect } from 'vitest'
import { remakeLooks, refuseReason, personIn, bodyChanged, aspectOf } from './looks.js'
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'

const body = (o: Partial<BodyReading> = {}): BodyReading => ({ framing: 'full_body', orientation: 'vertical', torso_angle_deg: 0, knees: 'straight', arms: { left: 'down', right: 'down' }, knees_toward: 'center', feet_toward: 'center', legs_toward: 'center', leg_offset: 0, frames: 3, ...o })

export function breakdown(o: Partial<Breakdown> = {}): Breakdown {
  return {
    video: { fileId: 'vid', durationS: 10, width: 1080, height: 1920, fps: 30, hasAudio: true, caption: null, song: null, youtubeUrl: null, platform: 'upload', tooLong: false },
    overview: {
      format: 'f', layout: 'full frame', change_style: ['hard_cuts'],
      looks: [
        { label: 'a', approx_start_s: 0, approx_end_s: 4, outfit: 'red dress', expression: 'mouth closed', start_pose: 'stands', end_pose: 'stands', moves: [], measured: 'Measured: 1 person, full body' },
        { label: 'b', approx_start_s: 4, approx_end_s: 10, outfit: 'blue suit', expression: 'smiles', start_pose: 'sits', end_pose: 'stands', moves: [{ t_s: 6, limb: 'legs', direction: 'up', how: 'stands up' }] },
      ],
      subject_box: null, story: { setup: 's', cause: 'c', payoff: 'p' },
      moments: [{ t_s: 6, what: 'stands up', why_it_matters: 'payoff' }], setting: { floor: 'wood' },
      props: [{ prop: 'remote', where: 'left', when: 'all' }], trick: 'cut', sound: '', voice_lines: null, on_screen_text: ['SALE'],
      music: { mood: 'upbeat', genre: 'pop', instruments: '', has_vocals: true, song_name: null },
      keep_for_clone: [], swap_for_clone: [], never_copy: [],
    },
    measured: true, cuts: { cuts: [4], fades: [], duration_s: 10 }, hidden_cuts: [], sound: null,
    pose: { model: 'm', moves: [], camera_moves: [], looks: [
      { label: 'a', start_s: 0, end_s: 4.1, frames_used: 20, people: 1, people_max: 1, no_person: false, main_start: body(), main_end: body(), leg_side_start: 'center', leg_side_end: 'center', body_angle_end: 0, key_frames: [{ t_s: 0.2, people: [] }, { t_s: 3.9, people: [] }] },
      { label: 'b', start_s: 4.1, end_s: 10, frames_used: 30, people: 1, people_max: 1, no_person: false, main_start: body({ knees: 'bent' }), main_end: body(), leg_side_start: 'center', leg_side_end: 'center', body_angle_end: 0, key_frames: [] },
    ] },
    shots: [], sound_arc: '', short_shot_check: { checked: 0, status: 'ok' }, warnings: [],
    ...o,
  } as Breakdown
}

describe('remakeLooks', () => {
  it('uses the measured spans and guide frames when the pose was measured', () => {
    const [a, b] = remakeLooks(breakdown())
    expect([a.startS, a.endS, a.guideStartS, a.guideEndS]).toEqual([0, 4.1, 0.2, 3.9])
    expect(b.startS).toBe(4.1)
    expect(b.guideStartS).toBeCloseTo(4.6) // no key frames: start + min(0.5, span/4)
  })
  it('needs an end still when the look has moves or the body changes, not otherwise', () => {
    const [a, b] = remakeLooks(breakdown())
    expect(a.needsEndStill).toBe(false)
    expect(b.needsEndStill).toBe(true)
  })
  it('carries the measured people count, including no person', () => {
    const b = breakdown()
    b.pose!.looks[0] = { ...b.pose!.looks[0], people: 0, no_person: true, main_start: null, main_end: null }
    const [a] = remakeLooks(b)
    expect(a.noPerson).toBe(true)
    expect(personIn(a)).toBe(false)
  })
})

describe('refuseReason', () => {
  it('refuses a watch-only breakdown before any spend', () => {
    expect(refuseReason(breakdown({ watch_only: true }))).toMatch(/upload the video file/)
  })
  it('refuses when body readings are missing', () => {
    expect(refuseReason(breakdown({ pose: null }))).toMatch(/try again/)
  })
  it('refuses split screen plainly', () => {
    const b = breakdown(); b.overview.layout = 'split screen'
    expect(refuseReason(b)).toMatch(/split-screen/)
  })
  it('accepts a measured full-frame breakdown', () => {
    expect(refuseReason(breakdown())).toBeNull()
  })
  it('never names internals', () => {
    for (const b of [breakdown({ watch_only: true }), breakdown({ pose: null })]) {
      expect(refuseReason(b)).not.toMatch(/gemini|download|server|ai-service|gateway|yt-dlp/i)
    }
  })
})

describe('bodyChanged / aspectOf', () => {
  it('a raised arm is a change; identical readings are not', () => {
    expect(bodyChanged(body(), body())).toBe(false)
    expect(bodyChanged(body(), body({ arms: { left: 'down', right: 'raised' } }))).toBe(true)
    expect(bodyChanged(null, body())).toBe(false)
  })
  it('maps the reference shape to an output shape', () => {
    expect(aspectOf(breakdown())).toBe('9:16')
    expect(aspectOf(breakdown({ video: { ...breakdown().video, width: 1920, height: 1080 } }))).toBe('16:9')
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/looks.test.ts`
Expected: FAIL with `Failed to resolve import "./looks.js"`.

- [ ] **Step 4: Implement `looks.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/looks.ts
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { lookSpans } from '../tools/videoBreakdown/breakDownVideo.js'
import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
import type { RemakeLook } from './types.js'

const raised = (b: BodyReading) => `${b.arms.left === 'raised'}${b.arms.right === 'raised'}`

/** The body visibly differs between a look's start and end (so an end still is needed). */
export function bodyChanged(a: BodyReading | null, b: BodyReading | null): boolean {
  if (!a || !b) return false
  return a.framing !== b.framing || a.orientation !== b.orientation || a.knees !== b.knees || a.knees_toward !== b.knees_toward || raised(a) !== raised(b)
}

export function remakeLooks(b: Breakdown): RemakeLook[] {
  const spans = new Map(lookSpans(b.overview, b.hidden_cuts, b.video.durationS).map((s) => [s.label, s]))
  const measured = new Map((b.pose?.looks ?? []).map((l) => [l.label, l]))
  return b.overview.looks.flatMap((l, i) => {
    const m = measured.get(l.label)
    const s = m ?? spans.get(l.label)
    if (!s || !(s.end_s > s.start_s)) return []
    const startS = s.start_s, endS = s.end_s
    const pad = Math.min(0.5, (endS - startS) / 4)
    const kf = m?.key_frames ?? []
    const start = m?.main_start ?? null, end = m?.main_end ?? null
    const moves = (l.moves ?? []).length + (b.pose?.moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS).length
    return [{
      n: i + 1, label: l.label, startS, endS,
      outfit: l.outfit ?? '', expression: l.expression ?? '', startPose: l.start_pose ?? '', endPose: l.end_pose ?? '',
      measured: l.measured ?? null, people: m?.people ?? null, noPerson: m?.no_person ?? null, start, end, moves,
      guideStartS: kf[0]?.t_s ?? startS + pad,
      guideEndS: kf.length ? kf[kf.length - 1].t_s : endS - pad,
      needsEndStill: moves > 0 || bodyChanged(start, end),
    }]
  })
}

export const personIn = (l: RemakeLook): boolean => (l.people ?? 0) > 0

/** Plain words for the user when a breakdown cannot be remade safely; null when it can. */
export function refuseReason(b: Breakdown): string | null {
  if (b.watch_only) return 'I only had a quick read of this video, so I can’t plan an exact remake from it. Please upload the video file here and I’ll break it down properly first.'
  if (b.video.tooLong) return 'This video is long. Tell me which part to remake first.'
  if (/split/i.test(b.overview.layout)) return 'Split-screen videos can’t be remade yet.'
  if (!b.pose) return 'I couldn’t read the body positions in this video this time. Please try again in a minute.'
  if (!remakeLooks(b).length) return 'I couldn’t find the separate parts of this video, so I can’t plan a remake.'
  return null
}

export function aspectOf(b: Breakdown): '9:16' | '16:9' | '1:1' {
  const { width: w, height: h } = b.video
  return h > w * 1.1 ? '9:16' : w > h * 1.1 ? '16:9' : '1:1'
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/looks.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/types.ts apps/agent-orchestrator/src/mastra/remake/looks.ts apps/agent-orchestrator/src/mastra/remake/looks.test.ts
git commit -m "feat(remake): looks with measured spans and guide frames; plain refusals before any spend"
```

---

### Task 3: The plan: refs, rules, edits, and the plan writer (`plan.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/plan.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/plan.test.ts`

**Interfaces:**
- Consumes: `remakeLooks`, `personIn`, `aspectOf` (Task 2); `askChecked`, `AskFn` (`tools/tvcChecks.ts`).
- Produces:
  - `planRefs(b: Breakdown, looks: RemakeLook[]): Array<{ ref: string; what: string }>`
  - `enforceRules(lines: PlanLine[], refs: Array<{ ref: string; what: string }>, ctx: { brand: Brand; musicMood: string }): { lines: PlanLine[]; warnings: string[] }`
  - `applyEdits(plan: RemakePlan, edits: PlanLine[], brand: Brand): RemakePlan`
  - `writePlan(b: Breakdown, brand: Brand, ask: AskFn): Promise<RemakePlan>`
  - `referenceOf(b: Breakdown): RemakeReference`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/plan.test.ts
import { describe, it, expect, vi } from 'vitest'
import { planRefs, enforceRules, applyEdits, writePlan } from './plan.js'
import { remakeLooks } from './looks.js'
import { breakdown } from './looks.test.js'

const brand = { name: 'Bubbli', product: 'Bubbli lemon soda', audience: 'college students' }

describe('planRefs', () => {
  it('lists every breakdown element once, with cast only when someone is on screen', () => {
    const b = breakdown()
    const refs = planRefs(b, remakeLooks(b)).map((r) => r.ref)
    expect(refs).toEqual(['story', 'setting', 'cast', 'looks[0].outfit', 'looks[0].expression', 'looks[1].outfit', 'looks[1].expression', 'moments[0]', 'props[0]', 'onScreenText[0]', 'sound.music', 'trick'])
    const empty = breakdown(); empty.pose!.looks = empty.pose!.looks.map((l) => ({ ...l, people: 0, no_person: true }))
    expect(planRefs(empty, remakeLooks(empty)).map((r) => r.ref)).not.toContain('cast')
  })
})

describe('enforceRules', () => {
  const b = breakdown()
  const refs = planRefs(b, remakeLooks(b))
  const ctx = { brand, musicMood: 'upbeat, pop' }
  it('fills every missing ref with keep, marked auto', () => {
    const { lines } = enforceRules([], refs, ctx)
    expect(lines.map((l) => l.ref)).toEqual(refs.map((r) => r.ref))
    expect(lines.find((l) => l.ref === 'story')).toMatchObject({ action: 'keep', auto: true })
  })
  it('never keeps the music, the reference text, or the person', () => {
    const { lines, warnings } = enforceRules([
      { ref: 'sound.music', action: 'keep' }, { ref: 'onScreenText[0]', action: 'keep' }, { ref: 'cast', action: 'keep' },
    ], refs, ctx)
    expect(lines.find((l) => l.ref === 'sound.music')).toMatchObject({ action: 'swap', to: 'new music, same mood: upbeat, pop' })
    expect(lines.find((l) => l.ref === 'onScreenText[0]')).toMatchObject({ action: 'drop' })
    expect(lines.find((l) => l.ref === 'cast')).toMatchObject({ action: 'swap', to: 'a new person who fits college students' })
    expect(warnings).toHaveLength(3)
  })
  it('drops unknown refs and turns a swap with no replacement into keep, with warnings', () => {
    const { lines, warnings } = enforceRules([{ ref: 'looks[9].outfit', action: 'swap', to: 'x' }, { ref: 'props[0]', action: 'swap' }], refs, ctx)
    expect(lines.some((l) => l.ref === 'looks[9].outfit')).toBe(false)
    expect(lines.find((l) => l.ref === 'props[0]')).toMatchObject({ action: 'keep' })
    expect(warnings.join(' ')).toMatch(/looks\[9\]\.outfit/)
  })
  it('keeps the first line for a duplicated ref', () => {
    const { lines } = enforceRules([{ ref: 'story', action: 'drop', why: 'a' }, { ref: 'story', action: 'keep' }], refs, ctx)
    expect(lines.filter((l) => l.ref === 'story')).toEqual([{ ref: 'story', action: 'drop', why: 'a' }])
  })
})

describe('writePlan', () => {
  it('asks once with every ref and the brand, then enforces the rules', async () => {
    const ask = vi.fn().mockResolvedValue({ lines: [{ ref: 'looks[0].outfit', action: 'swap', to: 'yellow Bubbli tee' }, { ref: 'sound.music', action: 'keep' }] })
    const plan = await writePlan(breakdown(), brand, ask)
    const sent = (ask.mock.calls[0][0] as Array<{ text: string }>)[0].text
    expect(sent).toContain('looks[1].expression')
    expect(sent).toContain('Bubbli lemon soda')
    expect(sent).toMatch(/never a real or famous person/i)
    expect(plan.lines.find((l) => l.ref === 'looks[0].outfit')).toMatchObject({ action: 'swap', to: 'yellow Bubbli tee' })
    expect(plan.lines.find((l) => l.ref === 'sound.music')?.action).toBe('swap')
    expect(plan.needsCasting).toBe(true)
    expect(plan.aspectRatio).toBe('9:16')
    expect(plan.reference.videoFileId).toBe('vid')
  })
})

describe('applyEdits', () => {
  it('replaces lines by ref and re-applies the rules (an edit cannot keep the music)', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const next = applyEdits(plan, [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }, { ref: 'sound.music', action: 'keep' }], brand)
    expect(next.lines.find((l) => l.ref === 'looks[1].outfit')?.to).toBe('green kurta')
    expect(next.lines.find((l) => l.ref === 'sound.music')?.action).toBe('swap')
    expect(next.warnings.join(' ')).toMatch(/music/)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/plan.test.ts`
Expected: FAIL with `Failed to resolve import "./plan.js"`.

- [ ] **Step 3: Implement `plan.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/plan.ts
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { askChecked, type AskFn } from '../tools/tvcChecks.js'
import { remakeLooks, personIn, aspectOf } from './looks.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan, RemakeReference } from './types.js'

type Ref = { ref: string; what: string }

export function planRefs(b: Breakdown, looks: RemakeLook[]): Ref[] {
  const o = b.overview
  const out: Ref[] = [
    { ref: 'story', what: `${o.story.setup} / ${o.story.cause} / ${o.story.payoff}` },
    { ref: 'setting', what: Object.entries(o.setting).map(([k, v]) => `${k}: ${v}`).join('; ') },
  ]
  if (looks.some(personIn)) out.push({ ref: 'cast', what: 'the person on screen' })
  for (const l of looks) out.push({ ref: `looks[${l.n - 1}].outfit`, what: l.outfit }, { ref: `looks[${l.n - 1}].expression`, what: l.expression })
  o.moments.forEach((m, i) => out.push({ ref: `moments[${i}]`, what: `${m.t_s}s ${m.what}` }))
  o.props.forEach((p, i) => out.push({ ref: `props[${i}]`, what: `${p.prop} (${p.where})` }))
  o.on_screen_text.forEach((t, i) => out.push({ ref: `onScreenText[${i}]`, what: t }))
  out.push({ ref: 'sound.music', what: `${o.music.mood}, ${o.music.genre}` })
  if (o.voice_lines) out.push({ ref: 'sound.voice', what: o.voice_lines })
  out.push({ ref: 'trick', what: o.trick })
  return out
}

/** Code-owned rules (spec §1 non-goals, §9a): no copied music, voice script, reference text or person. */
export function enforceRules(lines: PlanLine[], refs: Ref[], ctx: { brand: Brand; musicMood: string }): { lines: PlanLine[]; warnings: string[] } {
  const known = new Set(refs.map((r) => r.ref))
  const warnings: string[] = []
  const byRef = new Map<string, PlanLine>()
  for (const l of lines) {
    if (!known.has(l.ref)) { warnings.push(`${l.ref}: not part of this video, ignored`); continue }
    if (!byRef.has(l.ref)) byRef.set(l.ref, l)
  }
  const out = refs.map(({ ref }): PlanLine => {
    let l = byRef.get(ref) ?? { ref, action: 'keep', auto: true }
    if (l.action === 'swap' && !l.to?.trim()) { warnings.push(`${ref}: swap had no replacement, kept as the reference`); l = { ref, action: 'keep' } }
    if (ref === 'sound.music' && l.action !== 'swap') {
      if (!l.auto) warnings.push('music: the original track is never copied, so it is replaced with new music in the same mood')
      l = { ref, action: 'swap', to: `new music, same mood: ${ctx.musicMood}` }
    }
    if (ref === 'sound.voice' && l.action === 'keep') { if (!l.auto) warnings.push('voice: the original words are never copied, so new words are needed'); l = { ref, action: 'swap', to: `new words for ${ctx.brand.name}` } }
    if (ref.startsWith('onScreenText[') && l.action === 'keep') { if (!l.auto) warnings.push(`${ref}: the reference's own text is never copied, so it is left out`); l = { ref, action: 'drop', why: 'the reference text is never copied' } }
    if (ref === 'cast' && l.action !== 'swap') { if (!l.auto) warnings.push('cast: the person is always a new person'); l = { ref, action: 'swap', to: `a new person who fits ${ctx.brand.audience ?? ctx.brand.name}` } }
    return l
  })
  return { lines: out, warnings }
}

export function referenceOf(b: Breakdown): RemakeReference {
  const o = b.overview
  return {
    setting: Object.entries(o.setting).map(([k, v]) => `${k}: ${v}`).join('; '),
    props: o.props.map((p) => ({ prop: p.prop, where: p.where, when: p.when })),
    moments: o.moments.map((m) => ({ t_s: m.t_s, what: m.what })),
    musicMood: [o.music.mood, o.music.genre].filter(Boolean).join(', '),
    videoFileId: b.video.fileId, durationS: b.video.durationS, width: b.video.width, height: b.video.height,
  }
}

const brandText = (brand: Brand) => [`name: ${brand.name}`, `product: ${brand.product}`, brand.audience && `audience: ${brand.audience}`, brand.notes && `notes: ${brand.notes}`].filter(Boolean).join('; ')

export async function writePlan(b: Breakdown, brand: Brand, ask: AskFn): Promise<RemakePlan> {
  const looks = remakeLooks(b)
  const refs = planRefs(b, looks)
  const reference = referenceOf(b)
  const v = await askChecked(ask, [{ text: `You plan a remake of a reference video for a brand. For EVERY ref below decide:
- keep: the remake copies it as it is (structure, poses, timing, story beats)
- swap: the remake replaces it with the brand's version; say exactly what in "to"
- drop: leave it out; say why in "why"
Rules: the person on screen is always a new person who fits the brand (describe age range and style only; never a real or famous person; no names). Outfits and props usually swap toward the brand's product and style. Moments, poses and the story's structure are kept. Never write the name of a real person or a character.
BRAND: ${brandText(brand)}
REFS: ${JSON.stringify(refs)}
Reply ONLY JSON {"lines":[{"ref":"","action":"keep|swap|drop","to":"","why":""}]}` }], [{ key: 'lines', type: 'array' }])
  const raw = (v.lines as unknown[]).filter((x): x is PlanLine => !!x && typeof x === 'object' && typeof (x as PlanLine).ref === 'string' && ['keep', 'swap', 'drop'].includes((x as PlanLine).action))
    .map((x) => ({ ref: x.ref, action: x.action, ...(x.to ? { to: x.to } : {}), ...(x.why ? { why: x.why } : {}) }))
  const { lines, warnings } = enforceRules(raw, refs, { brand, musicMood: reference.musicMood })
  return { lines, looks, reference, needsCasting: looks.some(personIn), aspectRatio: aspectOf(b), warnings }
}

export function applyEdits(plan: RemakePlan, edits: PlanLine[], brand: Brand): RemakePlan {
  const edited = new Map(edits.map((e) => [e.ref, { ...e, auto: undefined }]))
  const merged = plan.lines.map((l) => edited.get(l.ref) ?? l).concat(edits.filter((e) => !plan.lines.some((l) => l.ref === e.ref)))
  const refs = plan.lines.map((l) => ({ ref: l.ref, what: '' }))
  const { lines, warnings } = enforceRules(merged, refs, { brand, musicMood: plan.reference.musicMood })
  return { ...plan, lines, warnings }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/plan.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/plan.ts apps/agent-orchestrator/src/mastra/remake/plan.test.ts
git commit -m "feat(remake): keep/swap/drop plan for every breakdown element, rules enforced in code"
```

---

### Task 4: Cost estimate and ledger (`cost.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/cost.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/cost.test.ts`

**Interfaces:**
- Consumes: `RemakePlan`, `LedgerEntry` (Task 2).
- Produces:
  - `estimateCost(plan: RemakePlan, opts: { castProvided: boolean; microEach: bigint | null }): { images: number; firstPassMicro: string | null; maxMicro: string | null }`
  - `ledgerSummary(entries: LedgerEntry[]): { spentMicro: string; wastedMicro: string; failed: string[]; blocked: string[] }`
  - `credits(micro: string | null): string`, which formats micro-credits as credits with 2 decimals.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/cost.test.ts
import { describe, it, expect, vi } from 'vitest'
import { estimateCost, ledgerSummary, credits } from './cost.js'
import { writePlan } from './plan.js'
import { breakdown } from './looks.test.js'

const plan = () => writePlan(breakdown(), { name: 'B', product: 'p' }, vi.fn().mockResolvedValue({ lines: [] }))

describe('estimateCost', () => {
  it('counts the casting sheet plus one still per look plus end stills; max allows one retry per still', async () => {
    const e = estimateCost(await plan(), { castProvided: false, microEach: 1_000_000n })
    expect(e.images).toBe(4) // sheet + a start + b start + b end
    expect(e.firstPassMicro).toBe('4000000')
    expect(e.maxMicro).toBe('7000000') // sheet once + 3 stills twice
  })
  it('skips the sheet when the user brings their own person', async () => {
    expect(estimateCost(await plan(), { castProvided: true, microEach: 1_000_000n }).images).toBe(3)
  })
  it('says unknown, never zero, when the rate is missing', async () => {
    expect(estimateCost(await plan(), { castProvided: false, microEach: null }).firstPassMicro).toBeNull()
  })
})

describe('ledgerSummary', () => {
  it('splits spent from wasted on retries and lists failed and blocked items', () => {
    const s = ledgerSummary([
      { item: 'look 1 start still', attempt: 0, creditsMicro: '100', outcome: 'retried' },
      { item: 'look 1 start still', attempt: 1, creditsMicro: '100', outcome: 'kept' },
      { item: 'look 2 start still', attempt: 0, creditsMicro: '100', outcome: 'retried' },
      { item: 'look 2 start still', attempt: 1, creditsMicro: '100', outcome: 'failed' },
      { item: 'look 3 start still', attempt: 0, creditsMicro: '0', outcome: 'blocked' },
    ])
    expect(s).toEqual({ spentMicro: '400', wastedMicro: '300', failed: ['look 2 start still'], blocked: ['look 3 start still'] })
  })
  it('formats credits', () => {
    expect(credits('1234567')).toBe('1.23')
    expect(credits(null)).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/cost.test.ts`
Expected: FAIL with `Failed to resolve import "./cost.js"`.

- [ ] **Step 3: Implement `cost.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/cost.ts
import type { LedgerEntry, RemakePlan } from './types.js'

export function estimateCost(plan: RemakePlan, opts: { castProvided: boolean; microEach: bigint | null }) {
  const sheet = plan.needsCasting && !opts.castProvided ? 1 : 0
  const stills = plan.looks.reduce((n, l) => n + 1 + (l.needsEndStill ? 1 : 0), 0)
  const each = opts.microEach
  return {
    images: sheet + stills,
    firstPassMicro: each === null ? null : String(each * BigInt(sheet + stills)),
    maxMicro: each === null ? null : String(each * BigInt(sheet + stills * 2)),
  }
}

export function ledgerSummary(entries: LedgerEntry[]) {
  const sum = (xs: LedgerEntry[]) => String(xs.reduce((n, e) => n + BigInt(e.creditsMicro || '0'), 0n))
  return {
    spentMicro: sum(entries),
    wastedMicro: sum(entries.filter((e) => e.outcome === 'retried' || e.outcome === 'failed')),
    failed: [...new Set(entries.filter((e) => e.outcome === 'failed').map((e) => e.item))],
    blocked: [...new Set(entries.filter((e) => e.outcome === 'blocked').map((e) => e.item))],
  }
}

export const credits = (micro: string | null): string => (micro === null ? 'unknown' : (Number(BigInt(micro)) / 1e6).toFixed(2))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/cost.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/cost.ts apps/agent-orchestrator/src/mastra/remake/cost.test.ts
git commit -m "feat(remake): stills cost estimate (first pass and with one retry) and a spent/wasted ledger"
```

---

### Task 5: Prompts from plan lines (`prompts.ts`), and the prompt gate names no people

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/prompts.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/measuredLine.ts` (export `personWords`)
- Modify: `apps/agent-orchestrator/src/mastra/scorers/video/promptCheck.ts` (invented bullet)
- Test: `apps/agent-orchestrator/src/mastra/remake/prompts.test.ts`
- Test: `apps/agent-orchestrator/src/mastra/scorers/video/promptCheck.test.ts` (add one test)

**Interfaces:**
- Consumes: `RemakePlan`, `RemakeLook`, `Brand` (Task 2); `personWords(b: BodyReading, start: BodyReading | null): string[]`.
- Produces:
  - `castSheetPrompt(castTo: string): string`
  - `stillPrompt(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', brand: Brand, hasProductPhoto: boolean): string`
  - `stillGateInput(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', prompt: string): { prompt: string; planLine: string; look: Record<string, unknown> & { expression?: string }; startFrameObjects: string[]; keyMoments: string[] }`
  - `usesProduct(plan: RemakePlan, brand: Brand): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/prompts.test.ts
import { describe, it, expect, vi } from 'vitest'
import { castSheetPrompt, stillPrompt, stillGateInput, usesProduct } from './prompts.js'
import { writePlan, applyEdits } from './plan.js'
import { precheckPrompt } from '../scorers/video/promptCheck.js'
import { breakdown } from './looks.test.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda', audience: 'students' }
const plan = async () => applyEdits(await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] })), [
  { ref: 'looks[0].outfit', action: 'swap', to: 'yellow tee with a Bubbli soda can in hand' },
  { ref: 'props[0]', action: 'swap', to: 'a Bubbli soda can' },
], brand)

describe('stillPrompt', () => {
  it('is built from plan lines: swapped outfit, kept expression, measured body words, pose-only guide', async () => {
    const p = await plan()
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).toContain('yellow tee with a Bubbli soda can in hand')
    expect(s).not.toContain('red dress')
    expect(s).toContain('mouth closed')
    expect(s).toMatch(/Copy ONLY the body pose and camera framing from the second image/)
    expect(s).toMatch(/full body/)
    expect(s).toContain('a Bubbli soda can (left)')
    expect(s).toMatch(/Add nothing that is not described here/)
  })
  it('adds no smile to a closed-mouth look (the prompt pre-check passes)', async () => {
    const p = await plan()
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(precheckPrompt(s, { expression: p.looks[0].expression })).toEqual([])
  })
  it('uses the end pose and end body for an end still', async () => {
    const p = await plan()
    expect(stillPrompt(p, p.looks[1], 'end', brand, false)).toContain('Pose: stands')
    expect(stillPrompt(p, p.looks[1], 'start', brand, false)).toContain('Pose: sits')
  })
  it('a no-person look has no person sentence and a layout-only guide', async () => {
    const b = breakdown(); b.pose!.looks[0] = { ...b.pose!.looks[0], people: 0, no_person: true, main_start: null, main_end: null }
    const p = await writePlan(b, brand, vi.fn().mockResolvedValue({ lines: [] }))
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).toMatch(/No person in this image/)
    expect(s).toMatch(/Copy ONLY the layout and camera angle from the first image/)
    expect(s).not.toMatch(/same face/)
  })
  it('names the product photo only when there is one and a line uses the product', async () => {
    const p = await plan()
    expect(usesProduct(p, brand)).toBe(true)
    expect(stillPrompt(p, p.looks[0], 'start', brand, true)).toMatch(/third image is the brand's product/)
    expect(stillPrompt(p, p.looks[0], 'start', brand, false)).not.toMatch(/third image/)
  })
  it('drops a dropped prop and never uses the reference on-screen text', async () => {
    const p = applyEdits(await plan(), [{ ref: 'props[0]', action: 'drop', why: 'no' }], brand)
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).not.toMatch(/remote|soda can \(left\)/)
    expect(s).not.toContain('SALE')
  })
})

describe('castSheetPrompt', () => {
  it('asks for three new, different people and no real person', () => {
    const s = castSheetPrompt('a woman in her 20s, sporty')
    expect(s).toMatch(/three equal side-by-side panels/)
    expect(s).toContain('a woman in her 20s, sporty')
    expect(s).toMatch(/Not any real or famous person/)
  })
})

describe('stillGateInput', () => {
  it('carries the look lines and the visible objects, and no moments (a still has no action)', async () => {
    const p = await plan()
    const g = stillGateInput(p, p.looks[0], 'start', 'PROMPT')
    expect(g.planLine).toContain('looks[0].outfit: swap to yellow tee')
    expect(g.startFrameObjects).toEqual(['a Bubbli soda can'])
    expect(g.keyMoments).toEqual([])
    expect(g.look.expression).toBe('mouth closed')
  })
})
```

Add this test to `scorers/video/promptCheck.test.ts`:

```ts
it('asks the checker to flag names of real people or characters as invented', async () => {
  const ask = vi.fn().mockResolvedValue({ invented: [], contradicts: [], missing: [], hand_on_absent_object: [] })
  await promptCheckScorer.run({ input: { ask, prompt: 'a woman stands', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] }, output: null })
  expect((ask.mock.calls[0][0] as Array<{ text: string }>)[0].text).toMatch(/name of a real person or a character/)
})
```

(Use the file's existing imports; add `vi` and `promptCheckScorer` to them if they are missing.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/prompts.test.ts src/mastra/scorers/video/promptCheck.test.ts`
Expected: FAIL. prompts: `Failed to resolve import "./prompts.js"`; promptCheck: the new test fails on `toMatch(/name of a real person or a character/)`.

- [ ] **Step 3: Implement.** In `measuredLine.ts`, change `function personWords(` to `export function personWords(`. In `promptCheck.ts`, replace the invented bullet line with:

```
- invented: things the prompt adds that the reference/plan does not show (an expression, an effect, an action, or the name of a real person or a character)
```

Create `prompts.ts`:

```ts
// apps/agent-orchestrator/src/mastra/remake/prompts.ts
// Every paid prompt is BUILT here from plan lines and measured readings (spec rule 7.2),
// never written freehand. Words are general: any reel, any number of people.
import { personWords } from '../tools/videoBreakdown/measuredLine.js'
import { personIn } from './looks.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan } from './types.js'

const lineOf = (plan: RemakePlan, ref: string): PlanLine | undefined => plan.lines.find((l) => l.ref === ref)

/** What the remake shows for a ref: the original (keep), the replacement (swap), or nothing (drop). */
function shown(plan: RemakePlan, ref: string, original: string): string | null {
  const l = lineOf(plan, ref)
  if (!l || l.action === 'keep') return original.trim() || null
  return l.action === 'swap' ? l.to?.trim() || null : null
}

function visibleProps(plan: RemakePlan): string[] {
  return plan.reference.props.flatMap((p, i) => {
    const what = shown(plan, `props[${i}]`, p.prop)
    return what ? [`${what} (${p.where})`] : []
  })
}

export function usesProduct(plan: RemakePlan, brand: Brand): boolean {
  const name = brand.product.toLowerCase()
  return plan.lines.some((l) => l.action === 'swap' && !!l.to && l.to.toLowerCase().includes(name))
}

export function castSheetPrompt(castTo: string): string {
  return `One photo split into three equal side-by-side panels, numbered 1, 2 and 3 in small grey corner numbers. Each panel shows a different new person who fits: ${castTo}. Each is full body, standing, facing the camera, neutral expression, plain light-grey background, soft natural light. Three clearly different faces. Not any real or famous person. No other text.`
}

export function stillPrompt(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', brand: Brand, hasProductPhoto: boolean): string {
  const i = look.n - 1
  const person = personIn(look)
  const body = kind === 'start' ? look.start : look.end
  const pose = (kind === 'start' ? look.startPose : look.endPose) || look.startPose
  const outfit = shown(plan, `looks[${i}].outfit`, look.outfit)
  const expression = shown(plan, `looks[${i}].expression`, look.expression)
  const setting = shown(plan, 'setting', plan.reference.setting)
  const props = visibleProps(plan)
  const parts: string[] = []
  if (person) {
    parts.push('The person is the person in the first image: same face, hair and body.')
    parts.push('Copy ONLY the body pose and camera framing from the second image; not its person, face, outfit, setting or any text.')
    if (pose) parts.push(`Pose: ${pose}.`)
    const words = body ? personWords(body, null) : []
    if (words.length) parts.push(`Body: ${words.join(', ')}.`)
    if (look.people && look.people > 1) parts.push(`${look.people - 1} other people are in the shot as in the guide, each a different new person.`)
    if (outfit) parts.push(`Outfit: ${outfit}.`)
    if (expression) parts.push(`Expression: ${expression}.`)
  } else {
    parts.push('No person in this image.')
    parts.push('Copy ONLY the layout and camera angle from the first image; not its objects, text or logos.')
  }
  if (setting) parts.push(`Setting: ${setting}.`)
  if (props.length) parts.push(`Objects: ${props.join('; ')}.`)
  if (hasProductPhoto && usesProduct(plan, brand)) parts.push(`The ${person ? 'third' : 'second'} image is the brand's product: show it exactly as it is, same shape, colour and label.`)
  parts.push('Add nothing that is not described here: no extra people, effects, text or logos.')
  return parts.join(' ')
}

export function stillGateInput(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', prompt: string) {
  const i = look.n - 1
  const mine = plan.lines.filter((l) => l.ref.startsWith(`looks[${i}].`) || l.ref === 'setting' || l.ref === 'cast' || l.ref.startsWith('props['))
  const planLine = [`${kind} still of look ${look.n}`, ...mine.map((l) => `${l.ref}: ${l.action}${l.to ? ` to ${l.to}` : ''}${l.why ? ` (${l.why})` : ''}`)].join('; ')
  return {
    prompt, planLine,
    look: { expression: shown(plan, `looks[${i}].expression`, look.expression) ?? undefined, start_pose: look.startPose, end_pose: look.endPose, measured: look.measured },
    startFrameObjects: plan.reference.props.flatMap((p, j) => shown(plan, `props[${j}]`, p.prop) ?? []),
    keyMoments: [] as string[],
  }
}
```

Note: the no-person guide is the FIRST image (there is no portrait); Task 8's reference order matches: `[guide, product?]` for a no-person look and `[portrait, guide, product?]` for a look with a person.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/prompts.test.ts src/mastra/scorers/video/promptCheck.test.ts src/mastra/tools/videoBreakdown/measuredLine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/prompts.ts apps/agent-orchestrator/src/mastra/remake/prompts.test.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/measuredLine.ts apps/agent-orchestrator/src/mastra/scorers/video/promptCheck.ts apps/agent-orchestrator/src/mastra/scorers/video/promptCheck.test.ts
git commit -m "feat(remake): still and casting prompts built from plan lines and measured body words"
```

---

### Task 6: Measured pose check for a still (`poseCompare.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/poseCompare.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/poseCompare.test.ts`

**Interfaces:**
- Consumes: `BodyReading`, `ImagePose` (Task 1), `CheckResult` (`scorers/video/gate.ts`).
- Produces: `comparePose(ref: BodyReading | null, refPeople: number | null, got: ImagePose): CheckResult`, with `name: 'pose'` and `evidenceTimes: []`.

Rules (general, any reel):
- The reference has no person (`refPeople === 0`): pass only when the still has 0 people.
- The reference was not measured (`refPeople === null`, or `ref === null` while `refPeople > 0`): unknown.
- The still has 0 people while the reference has some: fail.
- The reference has exactly 1 person and the still has more: fail ("extra person").
- Field by field, compared only where the reference knows the value:
  - framing: equal, or a neighbour (full_body↔knees_up↔waist_up↔chest_up↔face);
  - body angle: within 25° when both angles are known, otherwise orientation must be equal;
  - knees: equal;
  - knees_toward: equal;
  - each arm: raised vs not raised must match.
- A field the reference knows but the still reads as `unknown` makes the result unknown (never a pass), unless another field already fails.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/poseCompare.test.ts
import { describe, it, expect } from 'vitest'
import { comparePose } from './poseCompare.js'
import type { BodyReading, ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'

const b = (o: Partial<BodyReading> = {}): BodyReading => ({ framing: 'full_body', orientation: 'vertical', torso_angle_deg: 2, knees: 'straight', arms: { left: 'down', right: 'down' }, knees_toward: 'center', feet_toward: 'center', legs_toward: 'center', leg_offset: 0, frames: 3, ...o })
const got = (main: Partial<BodyReading> | null, people = 1): ImagePose => ({ model: 'm', people, no_person: people === 0, main: main ? b(main) : null })

describe('comparePose', () => {
  it('passes a matching still and a neighbouring framing', () => {
    expect(comparePose(b(), 1, got({})).status).toBe('pass')
    expect(comparePose(b(), 1, got({ framing: 'knees_up' })).status).toBe('pass')
  })
  it('fails a far framing, a flipped leg side, a missing raised arm, and a 40° tilt', () => {
    expect(comparePose(b(), 1, got({ framing: 'chest_up' })).reason).toMatch(/framing/)
    expect(comparePose(b({ knees_toward: 'image-right' }), 1, got({ knees_toward: 'image-left' })).reason).toMatch(/image-right/)
    expect(comparePose(b({ arms: { left: 'down', right: 'raised' } }), 1, got({})).reason).toMatch(/right arm/)
    expect(comparePose(b({ torso_angle_deg: 0 }), 1, got({ torso_angle_deg: 40, orientation: 'diagonal' })).status).toBe('fail')
  })
  it('no person in the reference passes only an empty still', () => {
    expect(comparePose(null, 0, got(null, 0)).status).toBe('pass')
    expect(comparePose(null, 0, got({}, 1)).status).toBe('fail')
  })
  it('fails an empty still and an extra person', () => {
    expect(comparePose(b(), 1, got(null, 0)).status).toBe('fail')
    expect(comparePose(b(), 1, got({}, 2)).reason).toMatch(/extra person/)
    expect(comparePose(b(), 3, got({}, 3)).status).toBe('pass')
  })
  it('is unknown, never a pass, when the reference was not measured or the still hides what the reference shows', () => {
    expect(comparePose(null, null, got({})).status).toBe('unknown')
    expect(comparePose(b({ knees: 'bent' }), 1, got({ knees: 'unknown' })).status).toBe('unknown')
  })
  it('skips fields the reference itself could not read', () => {
    expect(comparePose(b({ knees: 'unknown', knees_toward: 'unknown' }), 1, got({ knees: 'bent', knees_toward: 'image-left' })).status).toBe('pass')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/poseCompare.test.ts`
Expected: FAIL with `Failed to resolve import "./poseCompare.js"`.

- [ ] **Step 3: Implement `poseCompare.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/poseCompare.ts
// The still's measured body against the reference look's measured body. Free and exact;
// general for any reel (no assumption about lying down, leg sides or one person).
import type { BodyReading, ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'
import type { CheckResult } from '../scorers/video/gate.js'

const FRAMINGS = ['full_body', 'knees_up', 'waist_up', 'chest_up', 'face']
const WORD: Record<string, string> = { full_body: 'full body', knees_up: 'knees up', waist_up: 'waist up', chest_up: 'chest up', face: 'face close-up' }
const known = (v: unknown) => v !== null && v !== undefined && v !== 'unknown'
const result = (status: CheckResult['status'], reason: string): CheckResult => ({ name: 'pose', status, reason, evidenceTimes: [] })

export function comparePose(ref: BodyReading | null, refPeople: number | null, got: ImagePose): CheckResult {
  if (refPeople === 0) return got.people === 0 ? result('pass', 'no person, as in the reference') : result('fail', 'a person appears where the reference has none')
  if (refPeople === null || !ref) return result('unknown', 'the reference body was not measured')
  if (got.people === 0 || !got.main) return result('fail', 'no person found in the still')
  if (refPeople === 1 && got.people > 1) return result('fail', `extra person: ${got.people} people in the still, 1 in the reference`)
  const g = got.main
  const diffs: string[] = []
  const unread: string[] = []
  const field = (name: string, a: unknown, b: unknown, same: (a: string, b: string) => boolean, say: (a: string, b: string) => string) => {
    if (!known(a)) return
    if (!known(b)) { unread.push(name); return }
    if (!same(String(a), String(b))) diffs.push(say(String(a), String(b)))
  }
  field('framing', ref.framing, g.framing, (a, b) => Math.abs(FRAMINGS.indexOf(a) - FRAMINGS.indexOf(b)) <= 1,
    (a, b) => `framing: reference ${WORD[a] ?? a}, still ${WORD[b] ?? b}`)
  if (ref.torso_angle_deg !== null && g.torso_angle_deg !== null) {
    const d = Math.abs(ref.torso_angle_deg - g.torso_angle_deg) % 360
    if (Math.min(d, 360 - d) > 25) diffs.push(`body angle: reference ${Math.round(ref.torso_angle_deg)}°, still ${Math.round(g.torso_angle_deg)}°`)
  } else {
    field('orientation', ref.orientation, g.orientation, (a, b) => a === b, (a, b) => `body: reference ${a}, still ${b}`)
  }
  field('knees', ref.knees, g.knees, (a, b) => a === b, (a, b) => `knees: reference ${a}, still ${b}`)
  field('knee side', ref.knees_toward, g.knees_toward, (a, b) => a === b, (a, b) => `knees fall to ${b} in the still, ${a} in the reference`)
  for (const side of ['left', 'right'] as const) {
    field(`${side} arm`, ref.arms[side], g.arms[side], (a, b) => (a === 'raised') === (b === 'raised'),
      (a) => `${side} arm: ${a === 'raised' ? 'raised in the reference, not in the still' : 'raised in the still, not in the reference'}`)
  }
  if (diffs.length) return result('fail', diffs.join('; '))
  if (unread.length) return result('unknown', `could not read in the still: ${unread.join(', ')}`)
  return result('pass', 'pose matches the reference')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/poseCompare.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/poseCompare.ts apps/agent-orchestrator/src/mastra/remake/poseCompare.test.ts
git commit -m "feat(remake): measured pose check for a still against the reference look"
```

---

### Task 7: Dependencies seam (`deps.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/deps.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/deps.test.ts`

**Interfaces:**
- Consumes: `generateImageItem`, `ImageItemInput` (`tools/generateImage.ts`); `MediaExecContext` (`tools/batchRunner.ts`); `gatewayAsk`, `runStillChecks`, `AskFn`, `Img` (`tools/tvcChecks.ts`); `fetchBase64` (`tools/checkClip.ts`); `fetchPresignedUrl`, `downloadToSessionCache` (`tools/mediaCache.ts`); `uploadFileWithKey` (`persistence.ts`); `aiService` (`tools/videoBreakdown/aiServiceClient.ts`); `runGate`, `CheckResult`, `VIDEO_CHECK_COST`; `promptCheckScorer`; `checkModel()`; `resolveRate`, `costMicro`; `imageModelFor`.
- Produces:

```ts
export interface RemakeDeps {
  ask: (tenantId: string) => AskFn
  generateStill: (input: ImageItemInput, exec: MediaExecContext, index: number) => Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }>
  fetchImage: (fileId: string, idToken: string) => Promise<Img>
  localFile: (fileId: string, idToken: string, scopeId: string) => Promise<string>
  upload: (idToken: string, key: string, name: string, content: Buffer, contentType: string) => Promise<string | null>
  poseImage: (path: string) => Promise<ImagePose>
  promptGate: (input: ReturnType<typeof stillGateInput> & { tenantId: string }) => Promise<CheckResult>
  stillChecks: (ask: AskFn, still: Img, opts: { lead?: Img; leadInShot?: boolean }) => Promise<{ passed: boolean; reasons: string[] }>
  ffmpeg: (args: string[]) => Promise<void>
  readFile: (path: string) => Buffer
  renderPreview: (job: PreviewJob) => Promise<string>
  imageRateMicro: () => Promise<bigint | null>
}
export function remakeDeps(): RemakeDeps
export function setRemakeDeps(d: Partial<RemakeDeps> | null): void
export const REMAKE_COST = { agentId: 'video-remake', workflowId: 'video-remake' }
```

(`PreviewJob` and `renderPreview` come from Task 9; in this task `deps.ts` imports them from `./preview.js`. To keep this task independently green, create `preview.ts` here with only the `PreviewJob` type and a `renderPreview` that throws `new Error('renderPreview: not built yet')`; Task 9 replaces the body.)

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/remake/deps.test.ts
import { it, expect, afterEach } from 'vitest'
import { remakeDeps, setRemakeDeps } from './deps.js'

afterEach(() => setRemakeDeps(null))

it('overrides only the parts a test sets, and resets to the real ones', async () => {
  setRemakeDeps({ imageRateMicro: async () => 5n })
  expect(await remakeDeps().imageRateMicro()).toBe(5n)
  expect(typeof remakeDeps().generateStill).toBe('function')
  setRemakeDeps(null)
  expect(remakeDeps().imageRateMicro).not.toBe(undefined)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/mastra/remake/deps.test.ts`
Expected: FAIL with `Failed to resolve import "./deps.js"`.

- [ ] **Step 3: Implement.** Create the `preview.ts` stub:

```ts
// apps/agent-orchestrator/src/mastra/remake/preview.ts
export interface PreviewJob { workDir: string; width: number; height: number; segments: Array<{ seconds: number; start: string | null; end: string | null }> }
export async function renderPreview(_job: PreviewJob): Promise<string> { throw new Error('renderPreview: not built yet') }
```

Then create `deps.ts`:

```ts
// apps/agent-orchestrator/src/mastra/remake/deps.ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { costMicro, resolveRate } from '@serverless-saas/credits'
import { generateImageItem, type ImageItemInput } from '../tools/generateImage.js'
import type { MediaExecContext } from '../tools/batchRunner.js'
import { gatewayAsk, runStillChecks, type AskFn, type Img } from '../tools/tvcChecks.js'
import { fetchBase64 } from '../tools/checkClip.js'
import { fetchPresignedUrl, downloadToSessionCache } from '../tools/mediaCache.js'
import { uploadFileWithKey } from '../../persistence.js'
import { aiService, type ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'
import { checkModel } from '../tools/videoBreakdown/models.js'
import { imageModelFor } from '../tools/imageEngine.js'
import { runGate, type CheckResult } from '../scorers/video/gate.js'
import { promptCheckScorer } from '../scorers/video/promptCheck.js'
import { renderPreview, type PreviewJob } from './preview.js'
import type { stillGateInput } from './prompts.js'

const execFile = promisify(execFileCb)
const MAX_LOCAL_BYTES = 300 * 1024 * 1024
export const REMAKE_COST = { agentId: 'video-remake', workflowId: 'video-remake' }

export interface RemakeDeps {
  ask: (tenantId: string) => AskFn
  generateStill: (input: ImageItemInput, exec: MediaExecContext, index: number) => Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }>
  fetchImage: (fileId: string, idToken: string) => Promise<Img>
  localFile: (fileId: string, idToken: string, scopeId: string) => Promise<string>
  upload: (idToken: string, key: string, name: string, content: Buffer, contentType: string) => Promise<string | null>
  poseImage: (path: string) => Promise<ImagePose>
  promptGate: (input: ReturnType<typeof stillGateInput> & { tenantId: string }) => Promise<CheckResult>
  stillChecks: (ask: AskFn, still: Img, opts: { lead?: Img; leadInShot?: boolean }) => Promise<{ passed: boolean; reasons: string[] }>
  ffmpeg: (args: string[]) => Promise<void>
  readFile: (path: string) => Buffer
  renderPreview: (job: PreviewJob) => Promise<string>
  imageRateMicro: () => Promise<bigint | null>
}

const real: RemakeDeps = {
  ask: (tenantId) => gatewayAsk(tenantId, fetch, checkModel(), REMAKE_COST),
  generateStill: (input, exec, index) => generateImageItem(input, exec, index),
  fetchImage: (fileId, idToken) => fetchBase64(fileId, idToken, AbortSignal.timeout(120_000)),
  localFile: async (fileId, idToken, scopeId) => (await downloadToSessionCache(scopeId, fileId, await fetchPresignedUrl(fileId, idToken), MAX_LOCAL_BYTES)).filePath,
  upload: async (idToken, key, name, content, contentType) => (await uploadFileWithKey(idToken, { key, name, content, contentType }))?.fileId ?? null,
  poseImage: (path) => aiService<ImagePose>('/media/pose-image', { path }),
  promptGate: ({ tenantId, ...input }) => runGate(promptCheckScorer, 'prompt', { ...input, tenantId }, []),
  stillChecks: (ask, still, opts) => runStillChecks(ask, still, opts),
  ffmpeg: async (args) => { await execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 120_000 }) },
  readFile: (path) => readFileSync(path),
  renderPreview: (job) => renderPreview(job),
  imageRateMicro: async () => {
    const rate = await resolveRate('image_generation', imageModelFor('gemini').rateSubject)
    return rate ? costMicro(rate.schema, { count: 1 }) : null
  },
}

let override: Partial<RemakeDeps> | null = null
export function setRemakeDeps(d: Partial<RemakeDeps> | null): void { override = d }
export function remakeDeps(): RemakeDeps { return override ? { ...real, ...override } : real }
```

If `costMicro` returns a `number` rather than a `bigint` in `@serverless-saas/credits`, wrap it as `BigInt(costMicro(...))` (check the declaration with `grep -n "export function costMicro" -r ../../packages`). Record that as a ledger ruling if the code changes.

- [ ] **Step 4: Run the test and type-check**

Run: `npx vitest run src/mastra/remake/deps.test.ts && npx tsc --noEmit -p . 2>&1 | grep -E 'src/mastra/remake' || true`
Expected: test PASS; no type errors under `src/mastra/remake`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/deps.ts apps/agent-orchestrator/src/mastra/remake/deps.test.ts apps/agent-orchestrator/src/mastra/remake/preview.ts
git commit -m "feat(remake): one injectable seam for every side effect of the remake run"
```

---

### Task 8: A paid still with gate, checks, one retry and ledger (`paidStill.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/paidStill.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/paidStill.test.ts`

**Interfaces:**
- Consumes: `RemakeDeps` (Task 7), `comparePose` (Task 6), `stillPrompt`/`stillGateInput` (Task 5), types (Task 2).
- Produces:

```ts
export interface StillCtx {
  tenantId: string; idToken: string; scopeId: string; runId: string
  exec: (slot: number) => MediaExecContext   // agent.toolCallId = `remake:${runId}`
  portrait: { fileId: string; img: Img } | null
}
export interface StillJob { look: RemakeLook; kind: 'start' | 'end'; prompt: string; references: string[]; aspectRatio: '9:16' | '16:9' | '1:1'; gate: ReturnType<typeof stillGateInput> }
export const slotFor = (n: number, kind: 'start' | 'end', attempt: number): number  // n*4 + (kind==='end'?2:0) + attempt; slot 0 = cast sheet
export async function makeStill(job: StillJob, ctx: StillCtx, deps: RemakeDeps): Promise<{ result: StillResult; ledger: LedgerEntry[] }>
```

Behaviour:
1. Run the gate on the prompt. `fail` or `unknown` → `blocked` (no spend), with the ledger entry `blocked`.
2. Generate with `engine: 'gemini'`.
3. No fileId → `failed` (reason `not enough credits` when `insufficientCredits`, else `the image could not be made`); ledger `failed`; stop.
4. Check: glitches plus the same face (`deps.stillChecks` with `lead = portrait`, `leadInShot` only for a look with a person), plus `comparePose(body, look.people, deps.poseImage(localFile(still)))`. If either check throws, the result is unknown.
5. Pass → `passed`, ledger `kept`. Unknown → `unchecked` (kept, no retry), ledger `kept`.
6. Fail on attempt 0 → ledger `retried`; build the retry prompt `${prompt} Fix: ${reasons}`; it goes through the gate AGAIN before paying (blocked → result `failed` with the first still's id and reasons). Fail on attempt 1 → `failed` (the fileId is kept so the user can see it), ledger `failed`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/paidStill.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeStill, slotFor, type StillCtx, type StillJob } from './paidStill.js'
import type { RemakeDeps } from './deps.js'
import { remakeLooks } from './looks.js'
import { breakdown } from './looks.test.js'

const look = remakeLooks(breakdown())[0]
const job: StillJob = { look, kind: 'start', prompt: 'P', references: ['portrait', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } }
const img = { data: 'AA', mime: 'image/jpeg' }
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: (slot) => ({ requestContext: { get: () => undefined }, agent: { toolCallId: `remake:r` } , slot } as never), portrait: { fileId: 'portrait', img } }
const pass = { name: 'prompt', status: 'pass' as const, reason: '', evidenceTimes: [] }
const okPose = { model: 'm', people: 1, no_person: false, main: look.start }

function deps(o: Partial<RemakeDeps> = {}): RemakeDeps {
  let n = 0
  return {
    ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x.jpg'), upload: vi.fn(),
    generateStill: vi.fn().mockImplementation(async () => ({ fileId: `still-${++n}`, creditsUsedMicro: '100' })),
    poseImage: vi.fn().mockResolvedValue(okPose),
    promptGate: vi.fn().mockResolvedValue(pass),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
    ffmpeg: vi.fn(), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn(), imageRateMicro: vi.fn(),
    ...o,
  } as RemakeDeps
}

describe('makeStill', () => {
  it('pays once and keeps a still that passes every check', async () => {
    const d = deps()
    const r = await makeStill(job, ctx, d)
    expect(r.result).toMatchObject({ fileId: 'still-1', status: 'passed' })
    expect(r.ledger).toEqual([{ item: 'look 1 start still', attempt: 0, creditsMicro: '100', outcome: 'kept' }])
    expect(d.generateStill).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'P', referenceFileIds: ['portrait', 'guide'], engine: 'gemini', aspectRatio: '9:16' }), expect.anything(), slotFor(1, 'start', 0))
  })
  it('blocks before paying when the gate fails or is unknown', async () => {
    for (const status of ['fail', 'unknown'] as const) {
      const d = deps({ promptGate: vi.fn().mockResolvedValue({ ...pass, status, reason: 'adds a smile' }) })
      const r = await makeStill(job, ctx, d)
      expect(r.result).toMatchObject({ status: 'blocked', fileId: null, reasons: ['adds a smile'] })
      expect(d.generateStill).not.toHaveBeenCalled()
    }
  })
  it('retries once with the reasons added, then stops', async () => {
    const d = deps({ poseImage: vi.fn().mockResolvedValue({ ...okPose, people: 2 }) })
    const r = await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledTimes(2)
    expect((d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toMatch(/^P Fix: extra person/)
    expect(d.promptGate).toHaveBeenCalledTimes(2)
    expect(r.result).toMatchObject({ status: 'failed', fileId: 'still-2' })
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'failed'])
  })
  it('keeps the retry when it passes', async () => {
    const d = deps({ stillChecks: vi.fn().mockResolvedValueOnce({ passed: false, reasons: ['two cans'] }).mockResolvedValue({ passed: true, reasons: [] }) })
    const r = await makeStill(job, ctx, d)
    expect(r.result).toMatchObject({ status: 'passed', fileId: 'still-2' })
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'kept'])
  })
  it('never retries on unknown: keeps the still as unchecked', async () => {
    const d = deps({ poseImage: vi.fn().mockRejectedValue(new Error('ai-service 500')) })
    const r = await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledTimes(1)
    expect(r.result.status).toBe('unchecked')
    expect(r.result.reasons.join(' ')).not.toMatch(/ai-service/)
  })
  it('stops on insufficient credits with a plain reason', async () => {
    const d = deps({ generateStill: vi.fn().mockResolvedValue({ insufficientCredits: true }) })
    const r = await makeStill(job, ctx, d)
    expect(r.result).toMatchObject({ status: 'failed', reasons: ['not enough credits'] })
  })
  it('checks the face only when the look has a person', async () => {
    const d = deps()
    await makeStill(job, ctx, d)
    expect(d.stillChecks).toHaveBeenCalledWith(expect.anything(), img, { lead: img, leadInShot: true })
  })
})

it('slots never collide between looks, kinds and attempts, and 0 is the casting sheet', () => {
  const all = [1, 2, 3].flatMap((n) => (['start', 'end'] as const).flatMap((k) => [0, 1].map((a) => slotFor(n, k, a))))
  expect(new Set(all).size).toBe(all.length)
  expect(all).not.toContain(0)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/paidStill.test.ts`
Expected: FAIL with `Failed to resolve import "./paidStill.js"`.

- [ ] **Step 3: Implement `paidStill.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/paidStill.ts
// One paid still, money-safe (spec §8a): the prompt is gated BEFORE every paid call
// (including the retry), the still is checked after, one automatic retry with the
// reasons added, and every attempt goes in the ledger.
import type { MediaExecContext } from '../tools/batchRunner.js'
import type { Img } from '../tools/tvcChecks.js'
import type { CheckResult } from '../scorers/video/gate.js'
import type { RemakeDeps } from './deps.js'
import { comparePose } from './poseCompare.js'
import { personIn } from './looks.js'
import type { stillGateInput } from './prompts.js'
import type { LedgerEntry, RemakeLook, StillResult } from './types.js'

export interface StillCtx {
  tenantId: string; idToken: string; scopeId: string; runId: string
  exec: (slot: number) => MediaExecContext
  portrait: { fileId: string; img: Img } | null
}
export interface StillJob { look: RemakeLook; kind: 'start' | 'end'; prompt: string; references: string[]; aspectRatio: '9:16' | '16:9' | '1:1'; gate: ReturnType<typeof stillGateInput> }

export const slotFor = (n: number, kind: 'start' | 'end', attempt: number): number => n * 4 + (kind === 'end' ? 2 : 0) + attempt

async function checkStill(fileId: string, job: StillJob, ctx: StillCtx, deps: RemakeDeps): Promise<CheckResult> {
  try {
    const still = await deps.fetchImage(fileId, ctx.idToken)
    const person = personIn(job.look)
    const [looks, pose] = await Promise.all([
      deps.stillChecks(deps.ask(ctx.tenantId), still, { lead: ctx.portrait?.img, leadInShot: person && !!ctx.portrait }),
      deps.localFile(fileId, ctx.idToken, ctx.scopeId).then((p) => deps.poseImage(p)),
    ])
    const body = job.kind === 'start' ? job.look.start : job.look.end
    const p = comparePose(body, job.look.people, pose)
    const reasons = [...looks.reasons, ...(p.status === 'fail' ? [p.reason] : [])]
    if (reasons.length) return { name: 'still', status: 'fail', reason: reasons.join('; '), evidenceTimes: [] }
    if (p.status === 'unknown') return { name: 'still', status: 'unknown', reason: p.reason, evidenceTimes: [] }
    return { name: 'still', status: 'pass', reason: 'passed every check', evidenceTimes: [] }
  } catch (err) {
    console.error('[remake] still check failed:', err instanceof Error ? err.message : String(err))
    return { name: 'still', status: 'unknown', reason: 'the still could not be checked this time', evidenceTimes: [] }
  }
}

export async function makeStill(job: StillJob, ctx: StillCtx, deps: RemakeDeps): Promise<{ result: StillResult; ledger: LedgerEntry[] }> {
  const item = `look ${job.look.n} ${job.kind} still`
  const base = { look: job.look.n, kind: job.kind }
  const ledger: LedgerEntry[] = []
  let prompt = job.prompt
  let last: { fileId: string; reasons: string[] } | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const gate = await deps.promptGate({ ...job.gate, prompt, tenantId: ctx.tenantId })
    if (gate.status !== 'pass') {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
      return last
        ? { result: { ...base, fileId: last.fileId, status: 'failed', reasons: last.reasons }, ledger }
        : { result: { ...base, fileId: null, status: 'blocked', reasons: [gate.reason] }, ledger }
    }
    const g = await deps.generateStill(
      { prompt, aspectRatio: job.aspectRatio, referenceFileIds: job.references, engine: 'gemini', title: `Remake look ${job.look.n} ${job.kind} still` },
      ctx.exec(slotFor(job.look.n, job.kind, attempt)), slotFor(job.look.n, job.kind, attempt))
    const spent = g.creditsUsedMicro ?? '0'
    if (!g.fileId) {
      if (!g.insufficientCredits) console.error(`[remake] ${item} not made: ${g.refusalReason ?? 'unknown'}`)
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'failed' })
      return { result: { ...base, fileId: last?.fileId ?? null, status: 'failed', reasons: [g.insufficientCredits ? 'not enough credits' : 'the image could not be made'] }, ledger }
    }
    const c = await checkStill(g.fileId, job, ctx, deps)
    if (c.status === 'pass' || c.status === 'unknown') {
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'kept' })
      return { result: { ...base, fileId: g.fileId, status: c.status === 'pass' ? 'passed' : 'unchecked', reasons: c.status === 'pass' ? [] : [c.reason] }, ledger }
    }
    ledger.push({ item, attempt, creditsMicro: spent, outcome: attempt === 0 ? 'retried' : 'failed' })
    last = { fileId: g.fileId, reasons: [c.reason] }
    prompt = `${job.prompt} Fix: ${c.reason}`
  }
  return { result: { ...base, fileId: last!.fileId, status: 'failed', reasons: last!.reasons }, ledger }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/paidStill.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/paidStill.ts apps/agent-orchestrator/src/mastra/remake/paidStill.test.ts
git commit -m "feat(remake): money-safe still: gate before every paid call, checks after, one retry, ledger"
```

---

### Task 9: Free preview renderer (`preview.ts`)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/remake/preview.ts` (replace the stub body)
- Test: `apps/agent-orchestrator/src/mastra/remake/preview.test.ts` (pure)
- Test: `apps/agent-orchestrator/src/mastra/remake/preview.realffmpeg.test.ts` (real ffmpeg, follows `assembleClips.realffmpeg.test.ts`)

**Interfaces:**
- Consumes: `RemakePlan`, `StillResult` (Task 2).
- Produces:
  - `PREVIEW_FPS = 30` (spec rule 7.12)
  - `previewSize(w: number, h: number): { width: number; height: number }`: the longest side 1080, even numbers
  - `previewSegments(plan: RemakePlan, stills: StillResult[], localPaths: Map<string, string>): PreviewJob['segments']`: one segment per look in time order, `seconds = endS - startS`; `start`/`end` are local paths of usable stills (`passed` or `unchecked`; a `failed` still with a fileId is also shown, because the user should see it); null means a grey card.
  - `renderPreview(job: PreviewJob): Promise<string>`: an mp4 path with exactly `round(total × 30)` frames, silent AAC audio. A look with an end still cross-fades start→end over 0.4s in its middle.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/preview.test.ts
import { it, expect, vi } from 'vitest'
import { previewSegments, previewSize } from './preview.js'
import { writePlan } from './plan.js'
import { breakdown } from './looks.test.js'

it('keeps the reference shape at 1080 on the long side', () => {
  expect(previewSize(1080, 1920)).toEqual({ width: 1080, height: 1920 })
  expect(previewSize(720, 1280)).toEqual({ width: 1080, height: 1920 })
  expect(previewSize(1920, 1080)).toEqual({ width: 1920, height: 1080 })
  expect(previewSize(1001, 1001)).toEqual({ width: 1080, height: 1080 })
})

it('one segment per look, timed from the measured spans; missing stills become grey cards', async () => {
  const plan = await writePlan(breakdown(), { name: 'B', product: 'p' }, vi.fn().mockResolvedValue({ lines: [] }))
  const segs = previewSegments(plan, [
    { look: 1, kind: 'start', fileId: 'a1', status: 'passed', reasons: [] },
    { look: 2, kind: 'start', fileId: null, status: 'blocked', reasons: ['x'] },
    { look: 2, kind: 'end', fileId: 'b2', status: 'failed', reasons: ['y'] },
  ], new Map([['a1', '/m/a1.jpg'], ['b2', '/m/b2.jpg']]))
  expect(segs).toEqual([
    { seconds: 4.1, start: '/m/a1.jpg', end: null },
    { seconds: 5.9, start: null, end: '/m/b2.jpg' },
  ])
})
```

```ts
// apps/agent-orchestrator/src/mastra/remake/preview.realffmpeg.test.ts
import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderPreview, PREVIEW_FPS } from './preview.js'

const dir = mkdtempSync(join(tmpdir(), 'remake-preview-'))
const still = (name: string, color: string) => {
  const p = join(dir, name)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=540x960`, '-frames:v', '1', p])
  return p
}
const probe = (p: string, args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args, p]).toString().trim()

it('renders exact frames, the right size and a silent audio track; grey cards fill missing stills', async () => {
  const out = await renderPreview({ workDir: dir, width: 1080, height: 1920, segments: [
    { seconds: 1.3, start: still('a.png', 'red'), end: null },
    { seconds: 2.0, start: still('b.png', 'blue'), end: still('c.png', 'green') },
    { seconds: 0.7, start: null, end: null },
  ] })
  expect(Number(probe(out, ['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0']))).toBe(Math.round(4.0 * PREVIEW_FPS))
  expect(probe(out, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])).toBe('1080,1920')
  expect(probe(out, ['-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0'])).toBe('aac')
}, 60_000)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/preview.test.ts src/mastra/remake/preview.realffmpeg.test.ts`
Expected: FAIL. `previewSegments`/`previewSize`/`PREVIEW_FPS` are not exported, and the stub throws `renderPreview: not built yet`.

- [ ] **Step 3: Implement `preview.ts`** (replaces the stub)

```ts
// apps/agent-orchestrator/src/mastra/remake/preview.ts
// The FREE preview (spec §8a "cheap → expensive"): every look's stills, timed exactly
// like the reference, before any clip is paid for. Silent: music comes with the clips.
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemakePlan, StillResult } from './types.js'

const execFile = promisify(execFileCb)
export const PREVIEW_FPS = 30
const FADE_S = 0.4
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(PREVIEW_FPS)]

export interface PreviewJob { workDir: string; width: number; height: number; segments: Array<{ seconds: number; start: string | null; end: string | null }> }

const even = (x: number) => Math.round(x / 2) * 2
export function previewSize(w: number, h: number): { width: number; height: number } {
  const s = Math.min(1080 / Math.min(w, h), 1920 / Math.max(w, h))
  return { width: even(w * s), height: even(h * s) }
}

const usable = (s: StillResult | undefined) => (s && s.fileId ? s.fileId : null)

export function previewSegments(plan: RemakePlan, stills: StillResult[], localPaths: Map<string, string>): PreviewJob['segments'] {
  const path = (id: string | null) => (id ? localPaths.get(id) ?? null : null)
  return [...plan.looks].sort((a, b) => a.startS - b.startS).map((l) => ({
    seconds: Math.round((l.endS - l.startS) * 1000) / 1000,
    start: path(usable(stills.find((s) => s.look === l.n && s.kind === 'start'))),
    end: path(usable(stills.find((s) => s.look === l.n && s.kind === 'end'))),
  }))
}

/** Frames per segment from cumulative edges, so the total is exactly round(total × fps). */
function frameCounts(seconds: number[]): number[] {
  let t = 0, prev = 0
  return seconds.map((d) => { t += d; const edge = Math.round(t * PREVIEW_FPS + 1e-9); const n = edge - prev; prev = edge; return n })
}

export async function renderPreview(job: PreviewJob): Promise<string> {
  const run = (args: string[]) => execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 120_000 })
  const { width: W, height: H } = job
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=gray,setsar=1`
  const frames = frameCounts(job.segments.map((s) => s.seconds))
  const parts: string[] = []
  for (const [i, s] of job.segments.entries()) {
    const n = frames[i]
    const d = (n / PREVIEW_FPS).toFixed(4)
    const out = join(job.workDir, `seg-${String(i).padStart(2, '0')}.mp4`)
    const a = s.start ?? s.end
    if (!a) {
      await run(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=${PREVIEW_FPS}`, '-frames:v', String(n), ...X264, out])
    } else if (s.start && s.end && n / PREVIEW_FPS > FADE_S * 2) {
      const offset = (n / PREVIEW_FPS / 2 - FADE_S / 2).toFixed(4)
      await run(['-loop', '1', '-t', d, '-i', s.start, '-loop', '1', '-t', d, '-i', s.end, '-filter_complex',
        `[0]${fit},fps=${PREVIEW_FPS}[a];[1]${fit},fps=${PREVIEW_FPS}[b];[a][b]xfade=transition=fade:duration=${FADE_S}:offset=${offset}[v]`,
        '-map', '[v]', '-frames:v', String(n), ...X264, out])
    } else {
      await run(['-loop', '1', '-t', d, '-i', a, '-vf', `${fit},fps=${PREVIEW_FPS}`, '-frames:v', String(n), ...X264, out])
    }
    parts.push(out)
  }
  const list = join(job.workDir, 'preview-segments.txt')
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'))
  const joined = join(job.workDir, 'preview-joined.mp4')
  await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined])
  const total = (frames.reduce((a, b) => a + b, 0) / PREVIEW_FPS).toFixed(4)
  const out = join(job.workDir, 'preview.mp4')
  await run(['-i', joined, '-f', 'lavfi', '-t', total, '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', total, out])
  return out
}
```

Note: when an xfade segment's two inputs end up one frame short, `-frames:v` would yield fewer than `n` frames. The real-ffmpeg test pins the exact total; if it fails by a frame, add `,tpad=stop_mode=clone:stop_duration=1` after `[v]`'s xfade (and ledger the ruling).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/preview.test.ts src/mastra/remake/preview.realffmpeg.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/preview.ts apps/agent-orchestrator/src/mastra/remake/preview.test.ts apps/agent-orchestrator/src/mastra/remake/preview.realffmpeg.test.ts
git commit -m "feat(remake): free still-by-still preview, frame-exact at 30fps, grey cards for missing looks"
```

---

### Task 10: The workflow and its private Mastra instance (`workflow.ts`, `instance.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/workflow.ts`
- Create: `apps/agent-orchestrator/src/mastra/remake/instance.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/workflow.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/__tests__/studioWorkflows.test.ts`

**Interfaces:**
- Consumes: Tasks 2 through 9.
- Produces:
  - Workflow id `video-remake`. Input: `{ tenantId: string; conversationId: string; breakdown: Breakdown; brand: Brand; castFileId?: string }`.
  - Steps and their suspend payloads (the `stage` field is what the tool reads):
    - `plan`: suspends `{ stage: 'plan_review', plan: RemakePlan, estimate }`. Resume `{ decision: 'edit', edits: PlanLine[] }` re-suspends with the edited plan; resume `{ decision: 'approve' }` continues.
    - `cast`: skipped when `!plan.needsCasting || castFileId`. Otherwise it pays for the sheet (slot 0) and suspends `{ stage: 'cast_pick', sheetFileId }`. Resume `{ pick: 1 | 2 | 3 }` crops that panel and uploads it as the portrait.
    - `stills`: no suspend. It extracts and uploads the guide frames, then makes every still (up to 4 at once).
    - `preview`: no suspend. Output `{ previewFileId: string | null; stills: StillResult[]; portraitFileId: string | null; ledger: LedgerEntry[]; summary: ReturnType<typeof ledgerSummary>; plan: RemakePlan }`.
  - Request-context keys read by the steps: `tenantId`, `idToken`, `conversationId`, `sessionId`, `agentId`, `sendEvent`. Every step throws `RemakeAccessError` when `requestContext.tenantId !== inputData.tenantId` or `idToken` is missing.
  - `instance.ts`: `remakeWorkflow(): Promise<Workflow>` (lazy private `new Mastra({ workflows: { 'video-remake': videoRemakeWorkflow }, storage, logger: false })`, storage = `getMastraStore()` imported lazily); `setRemakeStorageForTests(storage: MastraStorage | null)`.

Workflow state threading: each step's output carries everything later steps need (`tenantId`, `conversationId`, `plan`, `brand`, `castFileId`, `portraitFileId`, `stills`, `ledger`), because Mastra feeds one step's output into the next.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/workflow.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeWorkflow, setRemakeStorageForTests } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './looks.test.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda', audience: 'students' }
const rc = (tenantId = 't1') => { const r = new RequestContext(); r.set('tenantId', tenantId); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
let made = 0
let store: InMemoryStore

function fakeDeps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [{ ref: 'looks[0].outfit', action: 'swap', to: 'yellow Bubbli tee' }] }),
    generateStill: vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' })),
    fetchImage: vi.fn().mockResolvedValue({ data: 'AA', mime: 'image/jpeg' }),
    localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`),
    upload: vi.fn().mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: breakdown().pose!.looks[0].main_start }),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
    ffmpeg: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn().mockResolvedValue('/m/preview.mp4'),
    imageRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    ...o,
  }
}

beforeEach(() => { made = 0; store = new InMemoryStore(); setRemakeStorageForTests(store) })
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

// Both looks start with the same measured body as the fake still reading, so stills pass first time.
const ref = () => { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }

async function start(o: Partial<RemakeDeps> = {}, input: Record<string, unknown> = {}) {
  setRemakeDeps(fakeDeps(o))
  const w = await remakeWorkflow()
  const run = await w.createRun()
  const r = await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: ref(), brand, ...input }, requestContext: rc() })
  return { w, runId: run.runId, r }
}
const resume = async (runId: string, step: string, resumeData: unknown, ctx = rc()) =>
  (await (await remakeWorkflow()).createRun({ runId })).resume({ step, resumeData, requestContext: ctx })

describe('video-remake workflow', () => {
  it('stops for the plan review with the plan and a cost estimate, before any spend', async () => {
    const { r } = await start()
    expect(r.status).toBe('suspended')
    const s = (r as { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }).steps.plan.suspendPayload!
    expect(s.stage).toBe('plan_review')
    expect((s.plan as { lines: Array<{ ref: string; to?: string }> }).lines.find((l) => l.ref === 'looks[0].outfit')?.to).toBe('yellow Bubbli tee')
    expect(s.estimate).toMatchObject({ images: 4, firstPassMicro: '4000000' })
  })
  it('an edit re-suspends with the edited plan; approve moves to the casting sheet', async () => {
    const { runId } = await start()
    const e = await resume(runId, 'plan', { decision: 'edit', edits: [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }] })
    expect(e.status).toBe('suspended')
    const a = await resume(runId, 'plan', { decision: 'approve' })
    expect(a.status).toBe('suspended')
    const cast = (a as { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }).steps.cast.suspendPayload!
    expect(cast).toMatchObject({ stage: 'cast_pick', sheetFileId: 'img-1' })
  })
  it('the pick crops that panel, makes every still with the edit applied, and renders the free preview', async () => {
    const gen = vi.fn().mockImplementation(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const { runId } = await start({ generateStill: gen })
    await resume(runId, 'plan', { decision: 'edit', edits: [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }] })
    await resume(runId, 'plan', { decision: 'approve' })
    const done = await resume(runId, 'cast', { pick: 2 })
    expect(done.status).toBe('success')
    const out = (done as { result: Record<string, unknown> }).result
    expect(out.previewFileId).toBeTruthy()
    expect((out.stills as unknown[]).length).toBe(3)
    const prompts = gen.mock.calls.map((c) => c[0].prompt as string)
    expect(prompts.some((p) => p.includes('green kurta'))).toBe(true)
    expect(gen.mock.calls[1][0].referenceFileIds[0]).toMatch(/^up:/) // the cropped portrait comes first
    expect(out.summary).toMatchObject({ spentMicro: '400', wastedMicro: '0' }) // sheet + 3 stills
  })
  it('skips casting for a reel with nobody in it', async () => {
    const b = breakdown(); b.pose!.looks = b.pose!.looks.map((l) => ({ ...l, people: 0, no_person: true, main_start: null, main_end: null }))
    setRemakeDeps(fakeDeps({ poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 0, no_person: true, main: null }) }))
    const w = await remakeWorkflow(); const run = await w.createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
    const done = await resume(run.runId, 'plan', { decision: 'approve' })
    expect(done.status).toBe('success')
  })
  it('a resume from another tenant fails without spending', async () => {
    const gen = vi.fn()
    const { runId } = await start({ generateStill: gen })
    const r = await resume(runId, 'plan', { decision: 'approve' }, rc('intruder'))
    expect(r.status).toBe('failed')
    expect(gen).not.toHaveBeenCalled()
  })
  it('survives a fresh instance on the same store (an orchestrator restart)', async () => {
    const { runId } = await start()
    setRemakeStorageForTests(store) // rebuilds the private instance on the same storage
    const r = await resume(runId, 'plan', { decision: 'approve' })
    expect(r.status).toBe('suspended')
  })
})
```

Add to `__tests__/studioWorkflows.test.ts`:

```ts
it('does not register the paid remake workflow on the Studio-mounted Mastra instance', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  expect(src).not.toMatch(/video-remake|videoRemakeWorkflow|remake\/workflow/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/workflow.test.ts src/mastra/__tests__/studioWorkflows.test.ts`
Expected: the workflow tests FAIL with `Failed to resolve import "./instance.js"`; the studio test PASSES already (it guards a future regression).

- [ ] **Step 3: Implement `instance.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/instance.ts
// The remake workflow runs on its OWN Mastra instance: same Postgres store (so runs
// survive restarts), but never registered on the instance mounted at /studio, whose
// API has no user auth (review I5). Only the remake_video tool reaches it.
import { Mastra } from '@mastra/core'
import type { MastraStorage } from '@mastra/core/storage'
import { videoRemakeWorkflow } from './workflow.js'

let instance: Mastra | null = null
let testStorage: MastraStorage | null = null

export function setRemakeStorageForTests(storage: MastraStorage | null): void {
  testStorage = storage
  instance = null
}

export async function remakeWorkflow() {
  if (!instance) {
    const storage = testStorage ?? (await import('../memory.js')).getMastraStore()
    instance = new Mastra({ workflows: { 'video-remake': videoRemakeWorkflow }, storage, logger: false })
  }
  return instance.getWorkflow('video-remake')
}
```

- [ ] **Step 4: Implement `workflow.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/workflow.ts
// Phase 3a of the clone (spec §3, §5.3–5.4, §8a): plan → cast → checked stills → FREE
// preview. Suspends for the plan review and the cast pick; the remake_video tool resumes.
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { generatedFileKey } from '../../persistence.js'
import { remakeDeps } from './deps.js'
import { writePlan, applyEdits } from './plan.js'
import { estimateCost, ledgerSummary } from './cost.js'
import { castSheetPrompt, stillPrompt, stillGateInput, usesProduct } from './prompts.js'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { previewSegments, previewSize } from './preview.js'
import { personIn } from './looks.js'
import type { Brand, LedgerEntry, PlanLine, RemakePlan, StillResult } from './types.js'

export class RemakeAccessError extends Error {}
const MAX_PARALLEL = 4
const any = z.any()

type Rc = { get: (k: string) => unknown }
function access(rc: Rc, tenantId: string) {
  const t = rc.get('tenantId') as string | undefined
  const idToken = rc.get('idToken') as string | undefined
  if (!t || t !== tenantId || !idToken) throw new RemakeAccessError('not_found')
  const conversationId = (rc.get('conversationId') as string | undefined) ?? (rc.get('sessionId') as string | undefined) ?? 'unknown'
  return { tenantId: t, idToken, conversationId, scopeId: t }
}
const execFor = (rc: Rc, runId: string) => (slot: number) => ({ requestContext: rc, agent: { toolCallId: `remake:${runId}` }, slot } as never)

const inputSchema = z.object({ tenantId: z.string(), conversationId: z.string(), breakdown: any, brand: any, castFileId: z.string().optional() })
const planned = inputSchema.extend({ plan: any })

const planStep = createStep({
  id: 'plan', inputSchema, outputSchema: planned,
  suspendSchema: z.object({ stage: z.literal('plan_review'), plan: any, estimate: any }),
  resumeSchema: z.object({ decision: z.enum(['edit', 'approve']), edits: z.array(any).optional() }),
  execute: async ({ inputData, resumeData, suspendData, suspend, requestContext }) => {
    const { tenantId } = access(requestContext as Rc, inputData.tenantId)
    const deps = remakeDeps()
    const brand = inputData.brand as Brand
    let plan = (suspendData?.plan as RemakePlan | undefined) ?? await writePlan(inputData.breakdown as Breakdown, brand, deps.ask(tenantId))
    if (resumeData?.decision === 'approve' && suspendData?.plan) return { ...inputData, plan }
    if (resumeData?.decision === 'edit') plan = applyEdits(plan, (resumeData.edits ?? []) as PlanLine[], brand)
    const estimate = estimateCost(plan, { castProvided: !!inputData.castFileId, microEach: await deps.imageRateMicro() })
    return await suspend({ stage: 'plan_review', plan, estimate })
  },
})

// the casting sheet's charge rides along so the cost meter counts it
const casted = planned.extend({ portraitFileId: z.string().nullable(), ledger: z.array(any) })
const castStep = createStep({
  id: 'cast', inputSchema: planned, outputSchema: casted,
  suspendSchema: z.object({ stage: z.literal('cast_pick'), sheetFileId: z.string(), sheetCreditsMicro: z.string() }),
  resumeSchema: z.object({ pick: z.number().int().min(1).max(3) }),
  execute: async ({ inputData, resumeData, suspendData, suspend, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId)
    const plan = inputData.plan as RemakePlan
    if (!plan.needsCasting) return { ...inputData, portraitFileId: null, ledger: [] }
    if (inputData.castFileId) return { ...inputData, portraitFileId: inputData.castFileId, ledger: [] }
    const deps = remakeDeps()
    if (!resumeData || !suspendData?.sheetFileId) {
      const castTo = plan.lines.find((l) => l.ref === 'cast')?.to ?? 'a new person'
      const g = await deps.generateStill({ prompt: castSheetPrompt(castTo), aspectRatio: '16:9', engine: 'gemini', skipAvatarExpansion: true, title: 'Remake casting sheet' }, execFor(requestContext as Rc, runId)(0), 0)
      if (!g.fileId) throw new Error(g.insufficientCredits ? 'not enough credits for the casting sheet' : 'the casting sheet could not be made')
      return await suspend({ stage: 'cast_pick', sheetFileId: g.fileId, sheetCreditsMicro: g.creditsUsedMicro ?? '0' })
    }
    const dir = mkdtempSync(join(tmpdir(), 'remake-cast-'))
    const sheet = await deps.localFile(suspendData.sheetFileId as string, a.idToken, a.scopeId)
    const out = join(dir, `cast-${resumeData.pick}.jpg`)
    await deps.ffmpeg(['-i', sheet, '-vf', `crop=iw/3:ih:(${resumeData.pick}-1)*iw/3:0`, '-frames:v', '1', '-q:v', '2', out])
    const id = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} cast ${resumeData.pick}`, 'jpg'), `Remake cast ${resumeData.pick}.jpg`, deps.readFile(out), 'image/jpeg')
    if (!id) throw new Error('the chosen person could not be saved')
    const sheet: LedgerEntry = { item: 'casting sheet', attempt: 0, creditsMicro: (suspendData.sheetCreditsMicro as string) ?? '0', outcome: 'kept' }
    return { ...inputData, portraitFileId: id, ledger: [sheet] }
  },
})

const stilled = casted.extend({ stills: z.array(any) })
const stillsStep = createStep({
  id: 'stills', inputSchema: casted, outputSchema: stilled,
  execute: async ({ inputData, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId)
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    const brand = inputData.brand as Brand
    const dir = mkdtempSync(join(tmpdir(), 'remake-guides-'))
    const source = await deps.localFile(plan.reference.videoFileId, a.idToken, a.scopeId)
    const guide = async (n: number, kind: 'start' | 'end', t: number) => {
      const out = join(dir, `guide-${n}-${kind}.jpg`)
      await deps.ffmpeg(['-ss', String(Math.max(0, t)), '-i', source, '-frames:v', '1', '-q:v', '2', out])
      return deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} look ${n} ${kind} guide`, 'jpg'), `Remake look ${n} ${kind} guide.jpg`, deps.readFile(out), 'image/jpeg')
    }
    const portraitId = inputData.portraitFileId
    const portrait = portraitId ? { fileId: portraitId, img: await deps.fetchImage(portraitId, a.idToken) } : null
    const product = brand.productPhotoFileId && usesProduct(plan, brand) ? brand.productPhotoFileId : null
    const ctx: StillCtx = { tenantId: a.tenantId, idToken: a.idToken, scopeId: a.scopeId, runId, exec: execFor(requestContext as Rc, runId), portrait }
    const jobs: Array<() => Promise<{ result: StillResult; ledger: LedgerEntry[] }>> = []
    for (const look of plan.looks) {
      for (const kind of (look.needsEndStill ? ['start', 'end'] : ['start']) as Array<'start' | 'end'>) {
        jobs.push(async () => {
          const g = await guide(look.n, kind, kind === 'start' ? look.guideStartS : look.guideEndS)
          if (!g) return { result: { look: look.n, kind, fileId: null, status: 'blocked', reasons: ['the pose guide could not be saved'] }, ledger: [] }
          const person = personIn(look)
          const references = [...(person && portrait ? [portrait.fileId] : []), g, ...(product ? [product] : [])]
          const prompt = stillPrompt(plan, look, kind, brand, !!product)
          const job: StillJob = { look, kind, prompt, references, aspectRatio: plan.aspectRatio, gate: stillGateInput(plan, look, kind, prompt) }
          return makeStill(job, ctx, deps)
        })
      }
    }
    const done: Array<{ result: StillResult; ledger: LedgerEntry[] }> = []
    for (let i = 0; i < jobs.length; i += MAX_PARALLEL) done.push(...await Promise.all(jobs.slice(i, i + MAX_PARALLEL).map((j) => j())))
    return { ...inputData, stills: done.map((d) => d.result), ledger: [...(inputData.ledger as LedgerEntry[]), ...done.flatMap((d) => d.ledger)] }
  },
})

const previewStep = createStep({
  id: 'preview', inputSchema: stilled, outputSchema: z.object({ previewFileId: z.string().nullable(), stills: z.array(any), portraitFileId: z.string().nullable(), ledger: z.array(any), summary: any, plan: any }),
  execute: async ({ inputData, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId)
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    const stills = inputData.stills as StillResult[]
    const ledger = inputData.ledger as LedgerEntry[]
    let previewFileId: string | null = null
    try {
      const paths = new Map<string, string>()
      for (const s of stills) if (s.fileId) paths.set(s.fileId, await deps.localFile(s.fileId, a.idToken, a.scopeId))
      const { width, height } = previewSize(plan.reference.width || 1080, plan.reference.height || 1920)
      const out = await deps.renderPreview({ workDir: mkdtempSync(join(tmpdir(), 'remake-preview-')), width, height, segments: previewSegments(plan, stills, paths) })
      previewFileId = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} preview`, 'mp4'), 'Remake preview.mp4', deps.readFile(out), 'video/mp4')
    } catch (err) {
      console.error('[remake] preview failed:', err instanceof Error ? err.message : String(err))
    }
    return { previewFileId, stills, portraitFileId: inputData.portraitFileId, ledger, summary: ledgerSummary(ledger), plan }
  },
})

export const videoRemakeWorkflow = createWorkflow({
  id: 'video-remake', inputSchema,
  outputSchema: z.object({ previewFileId: z.string().nullable(), stills: z.array(any), portraitFileId: z.string().nullable(), ledger: z.array(any), summary: any, plan: any }),
}).then(planStep).then(castStep).then(stillsStep).then(previewStep).commit()
```

Every file read goes through `deps.readFile` (Task 7), so tests need no real files.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/mastra/remake/ src/mastra/__tests__/studioWorkflows.test.ts`
Expected: all remake tests PASS, including the six workflow tests.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/ apps/agent-orchestrator/src/mastra/__tests__/studioWorkflows.test.ts
git commit -m "feat(remake): video-remake workflow (plan review, cast pick, checked stills, free preview) on a private Mastra instance"
```

---

### Task 11: The `remake_video` tool, registration and ownership

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (`remake_video: remakeVideoTool` next to `measure_pose`)
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (`DIRECTOR_TOOLS`: add `remake_video: remakeVideoTool`)
- Modify: `apps/agent-orchestrator/src/mastra/__tests__/serverTools.test.ts` (expected tool list)

**Interfaces:**
- Consumes: `remakeWorkflow` (Task 10), `recentBreakdown`/`breakDownVideo` (Phase 1), `refuseReason` (Task 2), `shouldRequireApproval` (`tools/generationApproval.ts`), `imageModelFor`, `credits` (Task 4), `linkSchema`.
- Produces: tool id `remake_video`. Input:

```ts
z.object({
  action: z.enum(['start', 'edit_plan', 'approve_plan', 'pick_cast', 'status']),
  url: linkSchema.optional(), fileId: z.string().optional(),            // start: the reference (same as break_down_video)
  brand: z.object({ name: z.string().min(1), product: z.string().min(1), productPhotoFileId: z.string().optional(), audience: z.string().optional(), notes: z.string().optional() }).optional(),
  castFileId: z.string().optional().describe('start: the user\'s own person (an avatar or photo fileId); skips the casting sheet'),
  runId: z.string().optional(),
  edits: z.array(z.object({ ref: z.string(), action: z.enum(['keep', 'swap', 'drop']), to: z.string().optional(), why: z.string().optional() })).optional(),
  pick: z.number().int().min(1).max(3).optional(),
})
```

Output: `{ success: boolean; runId?: string; stage?: 'plan_review' | 'cast_pick' | 'preview_ready'; plan?; estimate?: { images: number; firstPassCredits: string; maxCredits: string }; sheetFileId?; previewFileId?; stills?; summary?: { spentCredits: string; wastedCredits: string; failed: string[]; blocked: string[] }; warnings?: string[]; error?: string }`.

Rules:
- `start` with no `brand` → `error: 'brand_required'`. Get the breakdown with `recentBreakdown(input, { scopeId })` or run `breakDownVideo` (free to the user; the same as `break_down_video`). Then call `refuseReason`; a refusal returns `{ success: false, error: <plain words> }` with no run created.
- Every non-start action needs `runId`. The tool loads `getWorkflowRunById(runId)`. Missing, or `payload.tenantId`/`payload.conversationId` differs from the caller → `error: 'not_found'` (no detail).
- `requireApproval`: true only for `approve_plan` and `pick_cast`, via `shouldRequireApproval({ resourceType: 'image_generation', subject: imageModelFor('gemini').rateSubject }, ctx)`.
- A run that ends `failed` returns `error` with the first step error's message when it is one of the plain messages thrown by the steps ("not enough credits…", "…could not be made", "…could not be saved"); otherwise `'the remake stopped; please try again'`. `RemakeAccessError` maps to `not_found`.
- The description tells the agent the flow, the money gates and the user-facing wording.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { setRemakeStorageForTests } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { breakdown } from './looks.test.js'

vi.mock('../tools/videoBreakdown/breakDownVideo.js', async (orig) => ({
  ...(await orig<typeof import('../tools/videoBreakdown/breakDownVideo.js')>()),
  recentBreakdown: vi.fn(() => breakdown()),
  breakDownVideo: vi.fn(async () => breakdown()),
}))
vi.mock('../tools/generationApproval.js', async (orig) => ({ ...(await orig<typeof import('../tools/generationApproval.js')>()), shouldRequireApproval: vi.fn(async () => true) }))
const { remakeVideoTool } = await import('./remakeVideoTool.js')
const { recentBreakdown } = await import('../tools/videoBreakdown/breakDownVideo.js')

const ctx = (tenantId = 't1', conversationId = 'c1') => {
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId, conversationId, sessionId: 's1', idToken: 'tok' })) rc.set(k, v)
  return { requestContext: rc } as never
}
const brand = { name: 'Bubbli', product: 'Bubbli soda' }
const exec = (input: Record<string, unknown>, c = ctx()) => remakeVideoTool.execute!(input as never, c) as Promise<Record<string, unknown>>

beforeEach(() => {
  setRemakeStorageForTests(new InMemoryStore())
  let n = 0
  setRemakeDeps({
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    imageRateMicro: async () => 1_000_000n,
    generateStill: vi.fn(async () => ({ fileId: `img-${++n}`, creditsUsedMicro: '0' })),
  })
})
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('remake_video', () => {
  it('start returns the plan review with a cost estimate in credits', async () => {
    const r = await exec({ action: 'start', url: 'instagram.com/p/x', brand })
    expect(r).toMatchObject({ success: true, stage: 'plan_review', estimate: { images: 4, firstPassCredits: '4.00', maxCredits: '7.00' } })
    expect(r.runId).toBeTruthy()
  })
  it('start refuses a watch-only breakdown in plain words and creates no run', async () => {
    vi.mocked(recentBreakdown).mockReturnValueOnce(breakdown({ watch_only: true }))
    const r = await exec({ action: 'start', url: 'youtube.com/shorts/x', brand })
    expect(r.success).toBe(false)
    expect(String(r.error)).toMatch(/upload the video file/)
    expect(r.runId).toBeUndefined()
  })
  it('start needs the brand', async () => {
    expect(await exec({ action: 'start', url: 'instagram.com/p/x' })).toMatchObject({ success: false, error: 'brand_required' })
  })
  it('another conversation or tenant gets not_found for the same run', async () => {
    const { runId } = await exec({ action: 'start', url: 'instagram.com/p/x', brand })
    expect(await exec({ action: 'approve_plan', runId }, ctx('t1', 'other'))).toMatchObject({ success: false, error: 'not_found' })
    expect(await exec({ action: 'status', runId }, ctx('t2', 'c1'))).toMatchObject({ success: false, error: 'not_found' })
    expect(await exec({ action: 'status', runId: 'nope' })).toMatchObject({ success: false, error: 'not_found' })
  })
  it('edit_plan returns the edited plan; approve_plan returns the casting sheet', async () => {
    const { runId } = await exec({ action: 'start', url: 'instagram.com/p/x', brand })
    const e = await exec({ action: 'edit_plan', runId, edits: [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }] })
    expect((e.plan as { lines: Array<{ ref: string; to?: string }> }).lines.find((l) => l.ref === 'looks[1].outfit')?.to).toBe('green kurta')
    expect(await exec({ action: 'approve_plan', runId })).toMatchObject({ success: true, stage: 'cast_pick', sheetFileId: 'img-1' })
  })
  it('asks for approval only before paid stages', async () => {
    const need = (action: string) => remakeVideoTool.requireApproval!({ action } as never, ctx() as never)
    expect(await need('approve_plan')).toBe(true)
    expect(await need('pick_cast')).toBe(true)
    expect(await need('start')).toBe(false)
    expect(await need('edit_plan')).toBe(false)
  })
})
```

Update `__tests__/serverTools.test.ts`: add `'remake_video'` to the expected Olmo and Director tool lists, at the same position you register it.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mastra/remake/remakeVideoTool.test.ts src/mastra/__tests__/serverTools.test.ts`
Expected: FAIL. The import of `./remakeVideoTool.js` fails, and serverTools is missing `remake_video`.

- [ ] **Step 3: Implement `remakeVideoTool.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { linkSchema } from '../tools/videoBreakdown/links.js'
import { breakDownVideo, recentBreakdown, type Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { shouldRequireApproval } from '../tools/generationApproval.js'
import { imageModelFor } from '../tools/imageEngine.js'
import { refuseReason } from './looks.js'
import { credits } from './cost.js'
import { remakeWorkflow } from './instance.js'
import { RemakeAccessError } from './workflow.js'

const PLAIN = /^(not enough credits|the .* could not be (made|saved))/
const brandSchema = z.object({ name: z.string().min(1), product: z.string().min(1), productPhotoFileId: z.string().optional(), audience: z.string().optional(), notes: z.string().optional() })
const lineSchema = z.object({ ref: z.string(), action: z.enum(['keep', 'swap', 'drop']), to: z.string().optional(), why: z.string().optional() })

type Out = Record<string, unknown>
type RunResult = { status: string; steps?: Record<string, { suspendPayload?: Record<string, unknown>; error?: unknown }>; result?: Record<string, unknown>; error?: unknown; runId?: string }

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: string })?.message ?? ''
  if (e instanceof RemakeAccessError || msg === 'not_found') return 'not_found'
  return PLAIN.test(msg) ? msg : 'the remake stopped; please try again'
}

function shape(runId: string, r: RunResult): Out {
  if (r.status === 'suspended') {
    const p = Object.values(r.steps ?? {}).map((s) => s.suspendPayload).find((x) => x && x.stage) as Out | undefined
    if (!p) return { success: false, runId, error: 'the remake stopped; please try again' }
    if (p.stage === 'plan_review') {
      const e = p.estimate as { images: number; firstPassMicro: string | null; maxMicro: string | null }
      const plan = p.plan as { warnings?: string[] }
      return { success: true, runId, stage: 'plan_review', plan: p.plan, warnings: plan.warnings ?? [], estimate: { images: e.images, firstPassCredits: credits(e.firstPassMicro), maxCredits: credits(e.maxMicro) } }
    }
    return { success: true, runId, stage: 'cast_pick', sheetFileId: p.sheetFileId }
  }
  if (r.status === 'success' && r.result) {
    const s = r.result.summary as { spentMicro: string; wastedMicro: string; failed: string[]; blocked: string[] }
    return { success: true, runId, stage: 'preview_ready', previewFileId: r.result.previewFileId, stills: r.result.stills, summary: { spentCredits: credits(s.spentMicro), wastedCredits: credits(s.wastedMicro), failed: s.failed, blocked: s.blocked } }
  }
  const stepErr = Object.values(r.steps ?? {}).map((s) => s.error).find(Boolean) ?? r.error
  console.error('[remake] run ended', r.status, stepErr)
  return { success: false, runId, error: errorText(stepErr) }
}

export const remakeVideoTool = createTool({
  id: 'remake_video',
  description: 'Remake a reference video for the user\'s brand, step by step, with the user approving each paid step. '
    + 'start (link or fileId + brand: name, product, optional productPhotoFileId/audience/notes; optional castFileId when the user brings their own person): returns the remake plan (each part of the video kept, swapped or dropped) and the cost of the stills. Show the plan in plain words and ask for changes. '
    + 'edit_plan (runId + edits) for changes; approve_plan (runId) when the user agrees. If the video has a person, approve_plan returns a casting sheet of 3 new people: show it and ask which one (pick_cast, runId + pick 1-3). '
    + 'Then every look gets checked stills and a free preview video (stage preview_ready): share the preview, say which stills failed or were held back, and the credits spent. Video clips are a later step. '
    + 'Never describe how it works inside; use plain outcome words. status (runId) re-reads where a remake is.',
  inputSchema: z.object({
    action: z.enum(['start', 'edit_plan', 'approve_plan', 'pick_cast', 'status']),
    url: linkSchema.optional(), fileId: z.string().optional(),
    brand: brandSchema.optional(),
    castFileId: z.string().optional().describe('start: the user\'s own person (an avatar or photo fileId); skips the casting sheet'),
    runId: z.string().optional(),
    edits: z.array(lineSchema).optional(),
    pick: z.number().int().min(1).max(3).optional(),
  }),
  outputSchema: z.object({ success: z.boolean() }).passthrough(),
  requireApproval: async (input, ctx) => {
    const action = (input as { action?: string }).action
    if (action !== 'approve_plan' && action !== 'pick_cast') return false
    return shouldRequireApproval({ resourceType: 'image_generation', subject: imageModelFor('gemini').rateSubject }, ctx as never)
  },
  execute: async (input, execContext) => {
    const rc = execContext?.requestContext
    const tenantId = rc?.get('tenantId') as string | undefined
    const idToken = rc?.get('idToken') as string | undefined
    const sessionId = rc?.get('sessionId') as string | undefined
    const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
    if (!tenantId || !idToken || !conversationId) return { success: false, error: 'no_active_session' }
    const w = await remakeWorkflow()
    try {
      if (input.action === 'start') {
        if (!input.brand) return { success: false, error: 'brand_required' }
        if (!input.url && !input.fileId) return { success: false, error: 'link_or_file_required' }
        const ref = { url: input.url, fileId: input.fileId }
        const b: Breakdown = recentBreakdown(ref, { scopeId: tenantId }) ?? await breakDownVideo(ref, { idToken, scopeId: tenantId, conversationId }, tenantId)
        const refusal = refuseReason(b)
        if (refusal) return { success: false, error: refusal }
        const run = await w.createRun()
        const r = await run.start({ inputData: { tenantId, conversationId, breakdown: b, brand: input.brand, castFileId: input.castFileId }, requestContext: rc as never })
        return shape(run.runId, r as RunResult)
      }
      if (!input.runId) return { success: false, error: 'runId_required' }
      const state = await w.getWorkflowRunById(input.runId) as { payload?: { tenantId?: string; conversationId?: string }; status?: string; result?: unknown } | null
      if (!state || state.payload?.tenantId !== tenantId || state.payload?.conversationId !== conversationId) return { success: false, error: 'not_found' }
      const run = await w.createRun({ runId: input.runId })
      if (input.action === 'status') return shape(input.runId, state as unknown as RunResult)
      const [step, resumeData] = input.action === 'edit_plan' ? ['plan', { decision: 'edit', edits: input.edits ?? [] }]
        : input.action === 'approve_plan' ? ['plan', { decision: 'approve' }]
        : ['cast', { pick: input.pick }]
      if (input.action === 'pick_cast' && !input.pick) return { success: false, error: 'pick_required' }
      const r = await run.resume({ step, resumeData, requestContext: rc as never })
      return shape(input.runId, r as RunResult)
    } catch (err) {
      console.error('[remake] tool failed:', err instanceof Error ? err.message : String(err))
      return { success: false, error: errorText(err) }
    }
  },
})
```

Register: in `platformAgent.ts`, import `remakeVideoTool` from `'../remake/remakeVideoTool.js'` and add `remake_video: remakeVideoTool,` after `measure_pose: measurePoseTool,`. In `directorAgent.ts`, add the same import and append `remake_video: remakeVideoTool` to `DIRECTOR_TOOLS`.

The `status` action reads `state` as returned by `getWorkflowRunById`. Its shape (spike, 2026-10-15) is `{ status, payload, steps: { <id>: { suspendPayload, status } }, result? }`, so `shape()` reads it the same way as a run result. If `result` is absent on a finished run in that shape, read `state.steps.preview.output` instead and ledger the ruling.

- [ ] **Step 4: Run the tests to verify they pass, then the whole orchestrator suite and the type check**

Run: `npx vitest run src/mastra/remake/ src/mastra/__tests__/serverTools.test.ts src/mastra/__tests__/studioWorkflows.test.ts && npx vitest run > /tmp/remake-suite.txt 2>&1; tail -5 /tmp/remake-suite.txt && npx tsc --noEmit`
Expected: remake tests PASS; the whole suite reports the same failures as `main` before this branch, if any (compare against a run on `46bf8448`); `tsc` has no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.ts apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.test.ts apps/agent-orchestrator/src/mastra/agents/platformAgent.ts apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/__tests__/serverTools.test.ts
git commit -m "feat(remake): remake_video tool: start, edit, approve, pick; run ownership checked; approval before paid stages"
```

---

### Task 12: Skill text, deploy notes, and a live smoke

**Files:**
- Modify: `products/agent-platform/packages/api/seeds/official-skills/template-video.md` (append step 8, append-only)
- Modify: `docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md` (Phase 3a section)
- Test: `apps/agent-orchestrator/src/mastra/remake/skillText.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/remake/skillText.test.ts
import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const skill = readFileSync(join(import.meta.dirname, '../../../../../products/agent-platform/packages/api/seeds/official-skills/template-video.md'), 'utf8')

it('step 8 sends a brand remake through remake_video and keeps the earlier steps intact', () => {
  expect(skill).toMatch(/^8\. /m)
  expect(skill).toContain('remake_video')
  expect(skill).toMatch(/^7\. When the user shares a video link/m) // append-only: step 7 unchanged
})

it('step 8 names no internals', () => {
  const step8 = skill.split(/^8\. /m)[1] ?? ''
  expect(step8).not.toMatch(/download|server|gemini|ai-service|gateway|yt-dlp/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/mastra/remake/skillText.test.ts`
Expected: FAIL on `toMatch(/^8\. /m)`.

- [ ] **Step 3: Append step 8** to the end of `template-video.md`:

```markdown

8. When the user wants that video remade for their brand (adds to step 7): ask for the brand name and the product (and a product photo if they have one), then call remake_video with action "start", the same link or fileId, and the brand. If it refuses, pass its words on. Show the plan it returns in plain words: what stays the same, what changes to the brand, what is left out, and the stills' cost. Ask for changes; send them with action "edit_plan", and when the user agrees use "approve_plan". If a casting sheet comes back, show it and ask which of the 3 people to use ("pick_cast"). If the user has their own person, pass it as castFileId at start instead. When the preview is ready, share it, say plainly which stills failed or were held back and why, and the credits spent. Video clips are a separate later step; do not promise them yet.
```

Then add this section to the end of the DEPLOY doc:

```markdown
## Phase 3a (remake plan, casting, stills, free preview)

1. Pull main; `pm2 restart ai-service` (adds `/media/pose-image`; no new packages). Check: `curl -s -X POST localhost:3004/media/pose-image -H "x-internal-service-key: $INTERNAL_SERVICE_KEY" -H 'content-type: application/json' -d '{"path":"/nonexistent.jpg"}'` returns 400 or 403, not 404.
2. Rebuild and restart the orchestrator (ask first). The remake workflow uses the existing Mastra Postgres store; there is no migration.
3. Re-seed official skills (template-video step 8): `pnpm --filter @serverless-saas/agent-platform-api db:seed:official-skills` (the package name is in `products/agent-platform/packages/api/package.json`).
4. Check that `/studio/api/workflows` does NOT list `video-remake`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/mastra/remake/skillText.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (the `.md` files are gitignored, so add them with `-f`)

```bash
git add -f products/agent-platform/packages/api/seeds/official-skills/template-video.md docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md
git add apps/agent-orchestrator/src/mastra/remake/skillText.test.ts
git commit -m "docs(remake): template-video step 8 (remake_video) and Phase 3a deploy notes"
```

- [ ] **Step 6: Live smoke (after the VM deploy, with the user's go-ahead; spends about 4–7 image credits).** Through the internal test MCP, as a user in chat:
  1. Paste the IG fan reel `instagram.com/p/DdzH5VVgmYT/` with "remake this for Bubbli lemon soda, for college students". Expect a plan in plain words, the music swapped, the reference text dropped, and an estimate.
  2. Ask for one edit, then approve. Expect a casting sheet with 3 people.
  3. Pick 2. Expect a preview video with one segment per look, timed like the reference, and failed stills named plainly.
  4. `pm2 restart orchestrator` between steps 2 and 3 once, to prove the run survives (Review Focus 1).
  5. Repeat step 1 with a product-only reel (no person). Expect no casting sheet.
  6. Assess every output against the reference, with the measured lines in hand, before calling it done.

---

## Self-review notes (writer)

- Spec coverage for 3a: plan_remake (Task 3), casting (Task 10 cast step), checked stills (Tasks 6 and 8), free preview (Task 9), retry cap (Task 8), cost meter (Task 4 ledger, Task 11 summary), prompt check before every paid call (Task 8). Out of 3a, by the agreed split: Veo first+last, clips, music, final checks, recipes, `find_occluder`, compositor.
- Known simplifications to reconsider in 3b:
  - The guide frame comes from the source video at measured key-frame times. It is not yet cropped to the main person.
  - Extras in a many-people look are prompted generically.
  - Continuity edits (rule 7.4 "continuity edits before animating") are left to 3b, where clips need them.

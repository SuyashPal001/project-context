# Social Video Clone — Phase 2 (Checks + Money Safety) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the safety layer the remake (phase 3) will run on every step: measured moment times inside the breakdown, Mastra-native check scorers (props, same person, expression, pose + leg side, empty-hand action, prompt check), code-measured frame stats, a reference-comparison tool, and a Mastra `runEvals` golden set — so no paid generation is ever driven by a model's guess.

**Architecture:** Every check is a Mastra scorer built with `createScorer` from `@mastra/core/evals`, using FUNCTION-based steps that call our gateway (images go through `gatewayAsk`; Mastra prompt-object judges are text-only). One scorer definition serves three uses: (1) a blocking money gate called directly via `scorer.run()` inside phase-3 tools, (2) registered on the Mastra instance so Studio shows it, (3) the golden set via `runEvals` gates. CPU measurements (motion peaks, brightness jumps, occluder coverage) are new ai-service `/media/*` endpoints. Gemini says WHAT happens; code says exactly WHEN.

**Tech Stack:** TypeScript, Mastra 1.64 (`createScorer`, `runEvals`, `createWorkflow`/`createStep`), zod, vitest; Python FastAPI + OpenCV + numpy + pytest.

**Spec:** `docs/superpowers/specs/2026-10-14-social-video-clone-design.md` — §7 (rules), §8 (checks + checker rules), §8a (money safety), §14 (testing). Phase 1 code: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/`, `apps/ai-service/media/`.

## Global Constraints

- Watch/check model from env: `VIDEO_WATCH_MODEL` and `VIDEO_CHECK_MODEL`, both default `gemini-3.8-flash`.
- A check with no usable data reports `unknown` and is NEVER a pass. In Mastra score terms: pass = 1, fail = 0, unknown = 0 with `analyzeStepResult.status === 'unknown'`; gates treat unknown as not passing.
- Checks sample frames at MEASURED times (cuts, hidden cuts, refined moments), never at Gemini's rough times.
- Every check result carries `evidenceTimes: number[]` (the seconds it looked at).
- Moment refinement window ±1.5s; a moment keeps `measured: false` and Gemini's time when no clear motion peak is found.
- Leg side is judged on the FEET (where lower legs and feet end up), knees reported separately; directions are image-left / image-right.
- Same-person pass threshold: score ≥ 8/10, comparing against a frame from the SAME camera angle when one exists.
- Prompt check blocks on any `invented`, `contradicts`, `missing` or `hand_on_absent_object` entry; the deterministic pre-check (expression words) runs first and needs no model call.
- No new API keys: all model calls go through the existing gateway on Gemini.
- Checks are code the pipeline always runs; the only new agent tool is `compare_to_reference`.

## Review Focus

1. **The check model is down / returns junk** — every scorer must return status `unknown` (score 0), never pass. Test in Task 5 (`runGate` on a throwing ask) and Task 6.
2. **A moment Gemini places inside a fan/blade covered span or on a hard cut** — refinement must not snap to the cut or the occluder's motion. Test in Task 3 (exclude spans).
3. **A static video (near-still poster)** — refinement finds no peak, keeps Gemini's time with `measured:false`, no crash. Test in Task 2.
4. **Prompt mentions a smile when the look's expression says mouth closed** — blocked by the deterministic pre-check without a model call. Test in Task 6.
5. **Golden-set fixture video missing locally** — script reports which file is missing and exits non-zero, never a silent pass. Test in Task 8.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/models.ts` | `watchModel()`, `checkModel()` env-driven |
| `apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts` | `gatewayAsk(tenantId, fetchImpl, model?)`; `ExpectKeys` gains `'number' \| 'string'` |
| `apps/ai-service/media/motion.py` | `/media/motion-peaks`: motion energy in a box, peak near a hint time |
| `apps/ai-service/media/frame_stats.py` | `/media/brightness-jumps`, `/media/coverage` |
| `.../videoBreakdown/refineMoments.ts` | map moments/moves to boxes, call motion-peaks, write refined times |
| `apps/agent-orchestrator/src/mastra/scorers/video/gate.ts` | `CheckResult`, `runGate()` (scorer.run → pass/fail/unknown) |
| `.../scorers/video/visionScorers.ts` | prop count, same person, expression, pose+legs, empty hand |
| `.../scorers/video/promptCheck.ts` | deterministic pre-check + text judge |
| `.../videoBreakdown/compareToReference.ts` | function + `compare_to_reference` tool |
| `.../workflows/videoBreakdownWorkflow.ts` | workflow wrapper (local file) used as the golden-set target |
| `.../scorers/video/goldenScorers.ts` | deterministic scorers vs ground truth |
| `apps/agent-orchestrator/scripts/video-golden-set.ts` + `scripts/video-golden-set.fixtures.json` | `runEvals` with gates |

---

### Task 1: Model settings and check-helper extensions

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/models.ts`
- Modify: `.../videoBreakdown/geminiVideo.ts` (use `watchModel()`), `apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts` (`gatewayAsk` model param, `ExpectKeys` types)
- Test: `.../videoBreakdown/models.test.ts`, `apps/agent-orchestrator/src/mastra/tools/tvcChecks.askChecked.test.ts`

**Interfaces:**
- Produces: `watchModel(): string`, `checkModel(): string`; `gatewayAsk(tenantId: string, fetchImpl?: typeof fetch, model?: string): AskFn`; `ExpectKeys = Array<{ key: string; type: 'boolean' | 'array' | 'number' | 'string' }>`.

- [ ] **Step 1: Write the failing tests**

`models.test.ts`:
```ts
import { it, expect, afterEach } from 'vitest'
import { watchModel, checkModel } from './models.js'
afterEach(() => { delete process.env.VIDEO_WATCH_MODEL; delete process.env.VIDEO_CHECK_MODEL })
it('defaults both models to gemini-3.8-flash', () => {
  expect(watchModel()).toBe('gemini-3.8-flash')
  expect(checkModel()).toBe('gemini-3.8-flash')
})
it('reads the env settings so 3.6/3.8 can be switched without code', () => {
  process.env.VIDEO_WATCH_MODEL = 'gemini-3.6-flash'
  process.env.VIDEO_CHECK_MODEL = 'gemini-3.1-pro-preview'
  expect(watchModel()).toBe('gemini-3.6-flash')
  expect(checkModel()).toBe('gemini-3.1-pro-preview')
})
```

`tvcChecks.askChecked.test.ts`:
```ts
import { it, expect, vi } from 'vitest'
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
import { askChecked, gatewayAsk, CheckUnavailableError } from './tvcChecks.js'
it('accepts number and string keys', async () => {
  const ask = vi.fn(async () => ({ score: 9, feet: 'image-left' }))
  await expect(askChecked(ask, [{ text: 'q' }], [{ key: 'score', type: 'number' }, { key: 'feet', type: 'string' }])).resolves.toMatchObject({ score: 9 })
})
it('treats a wrong-typed number as missing (never a pass)', async () => {
  const ask = vi.fn(async () => ({ score: '9' }))
  await expect(askChecked(ask, [{ text: 'q' }], [{ key: 'score', type: 'number' }])).rejects.toBeInstanceOf(CheckUnavailableError)
})
it('gatewayAsk sends the model it is given', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })))
  await gatewayAsk('', fetchImpl, 'gemini-3.8-flash')([{ text: 'q' }])
  expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe('gemini-3.8-flash')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/videoBreakdown/models.test.ts src/mastra/tools/tvcChecks.askChecked.test.ts`
Expected: FAIL (module missing; number type unsupported; model ignored).

- [ ] **Step 3: Implement**

`models.ts`:
```ts
// Settings, not code: switch 3.6/3.8 (or Pro) without a deploy of new code.
// 3.8 Flash's price reportedly doubles on 2027-01-01 (spec §8a).
export const watchModel = (): string => process.env.VIDEO_WATCH_MODEL || 'gemini-3.8-flash'
export const checkModel = (): string => process.env.VIDEO_CHECK_MODEL || 'gemini-3.8-flash'
```
In `geminiVideo.ts`: replace `export const WATCH_MODEL = 'gemini-3.8-flash'` with `import { watchModel } from './models.js'` and use `const model = watchModel()` in `askGeminiVideo` for both the request `model` and `persistCost`. Keep exporting `WATCH_MODEL` as `export const WATCH_MODEL = 'gemini-3.8-flash' // default; runtime value comes from watchModel()` only if other files import it (grep first; if none, delete it).

In `tvcChecks.ts`:
```ts
export type ExpectKeys = Array<{ key: string; type: 'boolean' | 'array' | 'number' | 'string' }>
function verdictHasExpectedKeys(v: Record<string, unknown>, expectKeys: ExpectKeys): boolean {
  return expectKeys.every(({ key, type }) => (type === 'array' ? Array.isArray(v[key]) : typeof v[key] === type))
}
```
and `export function gatewayAsk(tenantId: string, fetchImpl: typeof fetch = fetch, model: string = PRO_CHECK_MODEL): AskFn` using `model` in the body and in `persistCost`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools && npx tsc --noEmit -p .`
Expected: PASS (existing tvcChecks tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoBreakdown/models.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/models.test.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/geminiVideo.ts apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts apps/agent-orchestrator/src/mastra/tools/tvcChecks.askChecked.test.ts
git commit -m "feat(video-breakdown): watch/check models as env settings; check helpers accept number/string keys"
```

---

### Task 2: ai-service `/media/motion-peaks`

**Files:**
- Create: `apps/ai-service/media/motion.py`, `apps/ai-service/tests/test_motion.py`
- Modify: `apps/ai-service/media/router.py`

**Interfaces:**
- Produces: `POST /media/motion-peaks` body `{path, items: [{id: str, t_s: float, box: [x0,y0,x1,y1]}], exclude: [[from_s, to_s]], window_s: 1.5}` → `{"items": [{"id", "t_s_in", "t_s", "measured": bool, "strength": float}]}`.
- Rule: motion energy = mean abs frame difference inside the box (grayscale, 160px wide working size). Frames inside any `exclude` span (±0.1s) get energy 0. A peak counts as measured only if its energy ≥ 3× the median energy of the window and ≥ 1.0.

- [ ] **Step 1: Write the failing tests**

```python
from conftest import ff

def _moving_square(path, start_s):
    # 5s grey video; a white square jumps around the lower half from start_s for 0.4s
    expr = f"if(between(t,{start_s},{start_s+0.4}),255,96)"
    ff(["-f", "lavfi", "-i", "color=gray:s=160x288:d=5:r=25",
        "-vf", f"drawbox=x='if(between(t,{start_s},{start_s+0.4}),40+80*mod(n,2),0)':y=200:w=40:h=40:color=white:t=fill:enable='between(t,{start_s},{start_s+0.4})'",
        "-c:v", "libx264", str(path)])

def test_snaps_to_the_real_motion_near_the_hint(client, media_dir):
    p = media_dir / "move.mp4"; _moving_square(p, 2.3)
    body = {"path": str(p), "items": [{"id": "legs", "t_s": 3.0, "box": [0, 0.5, 1, 1]}], "exclude": [], "window_s": 1.5}
    d = client.post("/media/motion-peaks", json=body, headers={"x-internal-service-key": "k"}).json()
    it = d["items"][0]
    assert it["measured"] is True and abs(it["t_s"] - 2.4) < 0.35

def test_static_video_keeps_the_hint_unmeasured(client, media_dir):
    p = media_dir / "still.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=160x288:d=4:r=25", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "items": [{"id": "x", "t_s": 2.0, "box": [0, 0, 1, 1]}], "exclude": [], "window_s": 1.5}
    it = client.post("/media/motion-peaks", json=body, headers={"x-internal-service-key": "k"}).json()["items"][0]
    assert it == {"id": "x", "t_s_in": 2.0, "t_s": 2.0, "measured": False, "strength": 0.0}

def test_ignores_motion_inside_an_excluded_span(client, media_dir):
    p = media_dir / "excl.mp4"; _moving_square(p, 2.3)
    body = {"path": str(p), "items": [{"id": "legs", "t_s": 2.5, "box": [0, 0.5, 1, 1]}], "exclude": [[2.2, 2.8]], "window_s": 1.5}
    it = client.post("/media/motion-peaks", json=body, headers={"x-internal-service-key": "k"}).json()["items"][0]
    assert it["measured"] is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests/test_motion.py -q`
Expected: FAIL (404).

- [ ] **Step 3: Implement `media/motion.py`**

```python
import cv2
import numpy as np

def _energies(path: str, box):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    x0, y0, x1, y1 = [min(1.0, max(0.0, float(v))) for v in box]
    prev, out = None, []
    while True:
        ok, img = cap.read()
        if not ok:
            break
        h, w = img.shape[:2]
        scale = 160 / w
        g = cv2.cvtColor(cv2.resize(img, (160, max(1, int(h * scale)))), cv2.COLOR_BGR2GRAY).astype(np.float32)
        gh, gw = g.shape
        crop = g[int(gh * y0):max(int(gh * y1), int(gh * y0) + 2), int(gw * x0):max(int(gw * x1), int(gw * x0) + 2)]
        out.append(0.0 if prev is None or prev.shape != crop.shape else float(np.mean(np.abs(crop - prev))))
        prev = crop
    return fps, np.array(out)

def motion_peaks(path: str, items: list[dict], exclude: list[list[float]], window_s: float = 1.5) -> dict:
    results, cache = [], {}
    for it in items:
        key = tuple(it["box"])
        if key not in cache:
            cache[key] = _energies(path, it["box"])
        fps, e = cache[key]
        e = e.copy()
        for a, b in exclude:
            e[max(0, int((a - 0.1) * fps)):min(len(e), int((b + 0.1) * fps) + 1)] = 0.0
        lo = max(0, int((it["t_s"] - window_s) * fps)); hi = min(len(e), int((it["t_s"] + window_s) * fps) + 1)
        win = e[lo:hi]
        if win.size == 0:
            results.append({"id": it["id"], "t_s_in": it["t_s"], "t_s": it["t_s"], "measured": False, "strength": 0.0}); continue
        k = int(np.argmax(win)); peak = float(win[k]); med = float(np.median(win))
        if peak >= 1.0 and peak >= 3 * max(med, 1e-6):
            results.append({"id": it["id"], "t_s_in": it["t_s"], "t_s": round((lo + k) / fps, 2), "measured": True, "strength": round(peak, 2)})
        else:
            results.append({"id": it["id"], "t_s_in": it["t_s"], "t_s": it["t_s"], "measured": False, "strength": round(peak, 2) if peak >= 1.0 else 0.0})
    return {"items": results}
```

`router.py` — add:
```python
from . import motion

class MotionItem(BaseModel):
    id: str
    t_s: float
    box: list[float]

class MotionBody(PathBody):
    items: list[MotionItem]
    exclude: list[list[float]] = []
    window_s: float = 1.5

@router.post("/motion-peaks")
def post_motion(body: MotionBody):
    for it in body.items:
        if len(it.box) != 4:
            raise HTTPException(status_code=400, detail="box must have 4 numbers")
    return motion.motion_peaks(str(safe_media_path(body.path)), [i.model_dump() for i in body.items], body.exclude, body.window_s)
```
(import `HTTPException` from fastapi at the top of router.py if not present.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests -q`
Expected: all pass. If `test_static_video_keeps_the_hint_unmeasured` gets a tiny non-zero strength from encoder noise, the rule (peak ≥ 1.0) must keep it unmeasured with strength 0.0 — fix the code, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/ai-service/media/motion.py apps/ai-service/media/router.py apps/ai-service/tests/test_motion.py
git commit -m "feat(ai-service): /media/motion-peaks — exact time of a movement near a hint"
```

---

### Task 3: Measured moment times inside `break_down_video`

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/refineMoments.ts`, `refineMoments.test.ts`
- Modify: `.../videoBreakdown/aiServiceClient.ts` (route union), `.../videoBreakdown/watchVideo.ts` (types: `measured?`), `.../videoBreakdown/breakDownVideo.ts`, `breakDownVideo.test.ts`

**Interfaces:**
- Consumes: `/media/motion-peaks` (Task 2), `WatchOverview`, `CutsResult`, `HiddenCutsResult`.
- Produces:
  - `limbBox(limb: string, subject: [number,number,number,number] | null): [number,number,number,number]` — legs/feet → lower 45% of the subject box; head/face → top 20%; arm/hand/remote/body/other → whole box; null subject → `[0.1,0.1,0.9,0.9]`.
  - `refineMoments(filePath: string, overview: WatchOverview, exclude: Array<[number, number]>, fetchImpl?): Promise<{ overview: WatchOverview; refined: number; unmeasured: number }>` — writes refined `t_s` and `measured` onto `overview.moments[]` and every `overview.looks[].moves[]`.
  - `moments[i].measured: boolean`, `looks[j].moves[k].measured: boolean`.

- [ ] **Step 1: Write the failing tests** (`refineMoments.test.ts`)

```ts
import { it, expect, vi } from 'vitest'
const ai = vi.fn()
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
import { limbBox, refineMoments } from './refineMoments.js'

it('maps limbs to the right part of the subject', () => {
  expect(limbBox('legs', [0.2, 0.1, 0.8, 0.9])).toEqual([0.2, 0.46, 0.8, 0.9])
  expect(limbBox('head', [0.2, 0.1, 0.8, 0.9])).toEqual([0.2, 0.1, 0.8, 0.26])
  expect(limbBox('right arm', null)).toEqual([0.1, 0.1, 0.9, 0.9])
})

it('writes measured times onto moments and moves, keeping unmeasured ones as they were', async () => {
  ai.mockResolvedValue({ items: [
    { id: 'm0', t_s_in: 1.5, t_s: 1.25, measured: true, strength: 9 },
    { id: 'l0-v0', t_s_in: 3.0, t_s: 3.3, measured: true, strength: 6 },
    { id: 'm1', t_s_in: 5.0, t_s: 5.0, measured: false, strength: 0 },
  ] })
  const overview = { subject_box: [0.2, 0.1, 0.8, 0.9], moments: [{ t_s: 1.5, what: 'points remote up', why_it_matters: '' }, { t_s: 5.0, what: 'blade covers', why_it_matters: '' }],
    looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 5, moves: [{ t_s: 3.0, limb: 'legs', direction: 'image-right', how: 'slide' }] }] } as any
  const r = await refineMoments('/m/a.mp4', overview, [[4.5, 6.1]])
  expect(r.overview.moments[0]).toMatchObject({ t_s: 1.25, measured: true })
  expect(r.overview.moments[1]).toMatchObject({ t_s: 5.0, measured: false })
  expect(r.overview.looks[0].moves[0]).toMatchObject({ t_s: 3.3, measured: true })
  expect(r).toMatchObject({ refined: 2, unmeasured: 1 })
  expect(ai.mock.calls[0][1].exclude).toEqual([[4.5, 6.1]])
})

it('leaves everything unmeasured when ai-service fails', async () => {
  ai.mockRejectedValue(new Error('ai-service 502'))
  const overview = { subject_box: null, moments: [{ t_s: 1, what: 'x', why_it_matters: '' }], looks: [] } as any
  const r = await refineMoments('/m/a.mp4', overview, [])
  expect(r.overview.moments[0]).toMatchObject({ t_s: 1, measured: false })
  expect(r.unmeasured).toBe(1)
})
```

In `breakDownVideo.test.ts` add (and mock `./refineMoments.js` at the top with `const refine = vi.fn(async (_p: string, o: unknown) => ({ overview: o, refined: 0, unmeasured: 0 }))` / `vi.mock('./refineMoments.js', () => ({ refineMoments: (...a: unknown[]) => refine(...a) }))`):
```ts
it('refines moment times, excluding hard cuts and covered spans', async () => {
  watch.mockResolvedValue(overview(['hidden_changes']))
  ai.mockImplementation(async (route: string) => {
    if (route === '/media/cuts') return { cuts: [7.0], fades: [], duration_s: 14.9 }
    if (route === '/media/hidden-cuts') return { hidden_cuts: [{ from: 'l0', to: 'l1', at_s: 5.43, covered_s: [4.5, 6.1] }], cover_threshold: 0.6 }
    return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
  })
  await breakDownVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
  expect(refine.mock.calls[0][2]).toEqual([[6.9, 7.1], [4.5, 6.1]])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/videoBreakdown/refineMoments.test.ts src/mastra/tools/videoBreakdown/breakDownVideo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`aiServiceClient.ts`: widen the route type to `'/media/cuts' | '/media/hidden-cuts' | '/media/sound' | '/media/motion-peaks' | '/media/brightness-jumps' | '/media/coverage'`.

`watchVideo.ts`: add `measured?: boolean` to the moment type and to the move type in `WatchOverview`.

`refineMoments.ts`:
```ts
import { aiService } from './aiServiceClient.js'
import type { WatchOverview } from './watchVideo.js'

type Box = [number, number, number, number]
const DEFAULT_BOX: Box = [0.1, 0.1, 0.9, 0.9]
const r2 = (n: number) => Math.round(n * 100) / 100

// Gemini says WHAT happens; code says exactly WHEN (spec §8a).
export function limbBox(limb: string, subject: Box | null): Box {
  const [x0, y0, x1, y1] = subject ?? DEFAULT_BOX
  const h = y1 - y0
  if (/leg|feet|foot|knee/i.test(limb)) return [x0, r2(y0 + h * 0.45), x1, y1]
  if (/head|face/i.test(limb)) return [x0, y0, x1, r2(y0 + h * 0.2)]
  return [x0, y0, x1, y1]
}

export async function refineMoments(filePath: string, overview: WatchOverview, exclude: Array<[number, number]>, fetchImpl?: typeof fetch): Promise<{ overview: WatchOverview; refined: number; unmeasured: number }> {
  const subject = (overview.subject_box ?? null) as Box | null
  const items: Array<{ id: string; t_s: number; box: Box }> = []
  overview.moments.forEach((m, i) => items.push({ id: `m${i}`, t_s: m.t_s, box: limbBox(m.what, subject) }))
  overview.looks.forEach((l, j) => (l.moves ?? []).forEach((v, k) => items.push({ id: `l${j}-v${k}`, t_s: v.t_s, box: limbBox(v.limb, subject) })))
  const byId = new Map<string, { t_s: number; measured: boolean }>()
  if (items.length) {
    try {
      const r = await aiService<{ items: Array<{ id: string; t_s: number; measured: boolean }> }>('/media/motion-peaks', { path: filePath, items, exclude, window_s: 1.5 }, fetchImpl)
      for (const it of r.items) byId.set(it.id, { t_s: it.t_s, measured: it.measured })
    } catch { /* unmeasured below; never a guess presented as measured */ }
  }
  let refined = 0, unmeasured = 0
  const apply = <T extends { t_s: number; measured?: boolean }>(x: T, id: string): T => {
    const hit = byId.get(id)
    if (hit?.measured) { refined++; return { ...x, t_s: hit.t_s, measured: true } }
    unmeasured++
    return { ...x, measured: false }
  }
  const out: WatchOverview = {
    ...overview,
    moments: overview.moments.map((m, i) => apply(m, `m${i}`)),
    looks: overview.looks.map((l, j) => ({ ...l, moves: (l.moves ?? []).map((v, k) => apply(v, `l${j}-v${k}`)) })),
  }
  return { overview: out, refined, unmeasured }
}
```

`breakDownVideo.ts`: import `refineMoments`; after `hidden` is computed and before `bounds`:
```ts
  const exclude: Array<[number, number]> = [
    ...(cuts?.cuts ?? []).map((c) => [Math.round((c - 0.1) * 100) / 100, Math.round((c + 0.1) * 100) / 100] as [number, number]),
    ...hidden.map((h) => h.covered_s),
  ]
  const r = await refineMoments(video.filePath, overview, exclude)
  const refinedOverview = r.overview
  if (r.unmeasured) warnings.push(`${r.unmeasured} moment time(s) could not be measured and are Gemini's estimate`)
```
and return `overview: refinedOverview` instead of `overview`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/videoBreakdown && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoBreakdown
git commit -m "feat(video-breakdown): measured moment and move times (motion peaks), Gemini only says what"
```

---

### Task 4: ai-service frame stats — brightness jumps and occluder coverage

**Files:**
- Create: `apps/ai-service/media/frame_stats.py`, `apps/ai-service/tests/test_frame_stats.py`
- Modify: `apps/ai-service/media/router.py`

**Interfaces:**
- Produces:
  - `POST /media/brightness-jumps` `{path, threshold: 3.0}` → `{"count": int, "jumps": [{"at_s", "delta"}]}` (whole-frame mean gray, frame to frame, 180px working width).
  - `POST /media/coverage` `{path, hsv_lo: [h,s,v], hsv_hi: [h,s,v], step_s: 0.2}` → `{"curve": [0..1 per step], "step_s"}` — fraction of frame inside the HSV range (the occluder), for comparing rhythm.

- [ ] **Step 1: Write the failing tests**

```python
from conftest import ff

def test_counts_a_sudden_flash(client, media_dir):
    p = media_dir / "flash.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=180x320:d=1:r=25", "-f", "lavfi", "-i", "color=black:s=180x320:d=0.2:r=25",
        "-f", "lavfi", "-i", "color=gray:s=180x320:d=1:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    d = client.post("/media/brightness-jumps", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert d["count"] == 2

def test_coverage_curve_tracks_a_brown_block(client, media_dir):
    p = media_dir / "cov.mp4"
    ff(["-f", "lavfi", "-i", "color=white:s=180x320:d=2:r=25", "-vf",
        "drawbox=x=0:y=0:w=180:h=160:color=0x6E4220:t=fill:enable='between(t,1,2)'", "-c:v", "libx264", str(p)])
    d = client.post("/media/coverage", json={"path": str(p), "hsv_lo": [0, 80, 25], "hsv_hi": [20, 255, 150], "step_s": 0.5}, headers={"x-internal-service-key": "k"}).json()
    assert d["curve"][0] < 0.05 and abs(d["curve"][-1] - 0.5) < 0.1
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests/test_frame_stats.py -q`
Expected: FAIL (404).

- [ ] **Step 3: Implement `media/frame_stats.py`**

```python
import cv2
import numpy as np

def _frames(path: str, width: int = 180):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    while True:
        ok, img = cap.read()
        if not ok:
            break
        h, w = img.shape[:2]
        yield fps, cv2.resize(img, (width, max(1, int(h * width / w))))

def brightness_jumps(path: str, threshold: float = 3.0) -> dict:
    prev, jumps, i = None, [], 0
    for fps, img in _frames(path):
        m = float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean())
        if prev is not None and abs(m - prev) > threshold:
            jumps.append({"at_s": round(i / fps, 2), "delta": round(m - prev, 1)})
        prev, i = m, i + 1
    return {"count": len(jumps), "jumps": jumps}

def coverage(path: str, hsv_lo, hsv_hi, step_s: float = 0.2) -> dict:
    curve, i, next_t = [], 0, 0.0
    for fps, img in _frames(path):
        t = i / fps
        if t + 1e-9 >= next_t:
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            mask = cv2.inRange(hsv, np.array(hsv_lo, np.uint8), np.array(hsv_hi, np.uint8))
            curve.append(round(float((mask > 0).mean()), 3))
            next_t += step_s
        i += 1
    return {"curve": curve, "step_s": step_s}
```

`router.py` — add:
```python
from . import frame_stats

class JumpsBody(PathBody):
    threshold: float = 3.0

class CoverageBody(PathBody):
    hsv_lo: list[int]
    hsv_hi: list[int]
    step_s: float = 0.2

@router.post("/brightness-jumps")
def post_jumps(body: JumpsBody):
    return frame_stats.brightness_jumps(str(safe_media_path(body.path)), body.threshold)

@router.post("/coverage")
def post_coverage(body: CoverageBody):
    if len(body.hsv_lo) != 3 or len(body.hsv_hi) != 3:
        raise HTTPException(status_code=400, detail="hsv_lo and hsv_hi need 3 numbers")
    return frame_stats.coverage(str(safe_media_path(body.path)), body.hsv_lo, body.hsv_hi, body.step_s)
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ai-service/media/frame_stats.py apps/ai-service/media/router.py apps/ai-service/tests/test_frame_stats.py
git commit -m "feat(ai-service): brightness-jump count and occluder coverage curve"
```

---

### Task 5: Vision check scorers (Mastra) and the gate

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/scorers/video/gate.ts`, `visionScorers.ts`, `visionScorers.test.ts`

**Interfaces:**
- Consumes: `gatewayAsk`, `askChecked`, `CheckUnavailableError`, `Img` (`tvcChecks.ts`); `checkModel()` (Task 1).
- Produces:
  - `interface CheckResult { name: string; status: 'pass' | 'fail' | 'unknown'; reason: string; evidenceTimes: number[] }`
  - `runGate(scorer: { run: (r: { input: unknown; output: unknown }) => Promise<{ score: number; analyzeStepResult?: unknown }> }, name: string, input: unknown, evidenceTimes: number[]): Promise<CheckResult>`
  - `type VisionInput = { ask?: AskFn; tenantId?: string }` merged into each scorer's `run.input`.
  - Scorers (each `createScorer({ id, name, description }).analyze(async ({ run }) => ...).generateScore(...)`), with `run.input` shapes:
    - `propCountScorer`: `{ frames: Img[]; prop: string; expected: number }` → analyze `{ status, counts: number[], reason }`
    - `samePersonScorer`: `{ reference: Img; frames: Img[] }` → `{ status, scores: number[], reason }` (pass if every score ≥ 8)
    - `expressionScorer`: `{ reference: Img; frame: Img; expected: string }` → `{ status, reason }`
    - `poseLegsScorer`: `{ reference: Img; frame: Img; expectedFeet: 'image-left' | 'image-right' | 'center' }` → `{ status, feet, knees, reason }`
    - `emptyHandScorer`: `{ frames: Img[] }` (time order) → `{ status, reason }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))
import { runGate } from './gate.js'
import { propCountScorer, samePersonScorer, poseLegsScorer, expressionScorer, emptyHandScorer } from './visionScorers.js'
import { CheckUnavailableError } from '../../tools/tvcChecks.js'

const img = { data: 'AA', mime: 'image/jpeg' }
const askReturning = (...vs: Array<Record<string, unknown>>) => { const f = vi.fn(); for (const v of vs) f.mockResolvedValueOnce(v); return f }

describe('runGate', () => {
  it('passes only on score 1 with status pass', async () => {
    const r = await runGate(propCountScorer, 'props', { ask: askReturning({ counts: [1, 1] }), frames: [img, img], prop: 'black remote', expected: 1 }, [0, 0.5])
    expect(r).toEqual({ name: 'props', status: 'pass', reason: expect.any(String), evidenceTimes: [0, 0.5] })
  })
  it('a check model that is down gives unknown, never pass', async () => {
    const ask = vi.fn(async () => { throw new CheckUnavailableError('down') })
    const r = await runGate(propCountScorer, 'props', { ask, frames: [img], prop: 'remote', expected: 1 }, [0])
    expect(r.status).toBe('unknown')
  })
})

describe('vision scorers', () => {
  it('prop count fails on a second remote', async () => {
    const r = await runGate(propCountScorer, 'props', { ask: askReturning({ counts: [1, 2] }), frames: [img, img], prop: 'black remote', expected: 1 }, [0, 0.5])
    expect(r.status).toBe('fail')
  })
  it('same person fails below 8/10', async () => {
    const r = await runGate(samePersonScorer, 'face', { ask: askReturning({ scores: [9, 6], differences: 'rounder jaw' }), reference: img, frames: [img, img] }, [1, 5])
    expect(r).toMatchObject({ status: 'fail' })
  })
  it('pose+legs judges the FEET side', async () => {
    const r = await runGate(poseLegsScorer, 'legs', { ask: askReturning({ feet: 'image-left', knees: 'image-right', same_pose: true, body_axis_same: true }), reference: img, frame: img, expectedFeet: 'image-left' }, [14.4])
    expect(r.status).toBe('pass')
  })
  it('pose+legs fails on a tilted body axis even when feet match', async () => {
    const r = await runGate(poseLegsScorer, 'legs', { ask: askReturning({ feet: 'image-right', knees: 'image-right', same_pose: true, body_axis_same: false }), reference: img, frame: img, expectedFeet: 'image-right' }, [11])
    expect(r.status).toBe('fail')
  })
  it('expression fails when the mouth differs', async () => {
    const r = await runGate(expressionScorer, 'expression', { ask: askReturning({ same_mouth: false, same_eyes: true, same_mood: false, what: 'smiling with teeth' }), reference: img, frame: img, expected: 'mouth closed, poised' }, [7])
    expect(r.status).toBe('fail')
  })
  it('empty hand action fails', async () => {
    const r = await runGate(emptyHandScorer, 'empty-hand', { ask: askReturning({ empty_hand_action: true, what: 'pinches air near shoulder' }), frames: [img, img] }, [9.5, 10])
    expect(r.status).toBe('fail')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/scorers/video/visionScorers.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`gate.ts`:
```ts
export interface CheckResult { name: string; status: 'pass' | 'fail' | 'unknown'; reason: string; evidenceTimes: number[] }

type RunnableScorer = { run: (r: { input: unknown; output: unknown }) => Promise<{ score: number; analyzeStepResult?: unknown }> }

// The blocking money gate: call the Mastra scorer directly (live evals are async
// and can't block spend). Unknown is never a pass (spec §8 checker rules).
export async function runGate(scorer: RunnableScorer, name: string, input: unknown, evidenceTimes: number[]): Promise<CheckResult> {
  try {
    const r = await scorer.run({ input, output: null })
    const a = (r.analyzeStepResult ?? {}) as { status?: 'pass' | 'fail' | 'unknown'; reason?: string }
    const status = a.status === 'unknown' ? 'unknown' : r.score === 1 && a.status === 'pass' ? 'pass' : 'fail'
    return { name, status, reason: a.reason ?? '', evidenceTimes }
  } catch (err) {
    return { name, status: 'unknown', reason: err instanceof Error ? err.message : String(err), evidenceTimes }
  }
}
```

`visionScorers.ts`:
```ts
import { createScorer } from '@mastra/core/evals'
import { askChecked, gatewayAsk, CheckUnavailableError, type AskFn, type AskPart, type Img } from '../../tools/tvcChecks.js'
import { checkModel } from '../../tools/videoBreakdown/models.js'

type Status = 'pass' | 'fail' | 'unknown'
type Verdict = { status: Status; reason: string } & Record<string, unknown>
const askFor = (input: { ask?: AskFn; tenantId?: string }): AskFn => input.ask ?? gatewayAsk(input.tenantId ?? '', fetch, checkModel())
const imgs = (label: string, frames: Img[]): AskPart[] => frames.flatMap((f, i) => [{ text: `${label} ${i + 1}:` }, { image: f }])

// Function-based analyze steps: Mastra prompt-object judges are text-only, ours need images.
function videoScorer(id: string, description: string, analyze: (input: any) => Promise<Verdict>) {
  return createScorer({ id, name: id, description })
    .analyze(async ({ run }) => {
      try { return await analyze(run.input) } catch (err) {
        if (err instanceof CheckUnavailableError) return { status: 'unknown' as Status, reason: err.message }
        throw err
      }
    })
    .generateScore(({ results }) => ((results.analyzeStepResult as Verdict).status === 'pass' ? 1 : 0))
    .generateReason(({ results }) => (results.analyzeStepResult as Verdict).reason)
}

export const propCountScorer = videoScorer('video-prop-count', 'Exactly the expected number of a prop in every frame', async (input: { ask?: AskFn; tenantId?: string; frames: Img[]; prop: string; expected: number }) => {
  const v = await askChecked(askFor(input), [...imgs('Frame', input.frames), { text: `For EACH frame in order, count how many ${input.prop} are visible (in hands or anywhere). Reply ONLY JSON {"counts":[n per frame]}` }], [{ key: 'counts', type: 'array' }])
  const counts = (v.counts as unknown[]).map(Number)
  if (counts.length !== input.frames.length) return { status: 'unknown', reason: 'checker skipped frames', counts }
  const bad = counts.map((c, i) => [c, i] as const).filter(([c]) => c !== input.expected)
  return bad.length ? { status: 'fail', reason: `${input.prop}: ${bad.map(([c, i]) => `${c} in frame ${i + 1}`).join(', ')} (expected ${input.expected})`, counts } : { status: 'pass', reason: `${input.expected} ${input.prop} in every frame`, counts }
})

export const samePersonScorer = videoScorer('video-same-person', 'Every frame shows the same person as the reference (8/10 or more)', async (input: { ask?: AskFn; tenantId?: string; reference: Img; frames: Img[] }) => {
  const v = await askChecked(askFor(input), [{ text: 'IDENTITY REFERENCE:' }, { image: input.reference }, ...imgs('Candidate', input.frames), { text: 'Judge ONLY the face (bone structure, face shape, nose, eyes, brows, lips, jaw; ignore hair, makeup, outfit, pose, angle). For each candidate give a same-person score 1-10. Reply ONLY JSON {"scores":[n per candidate],"differences":"short"}' }], [{ key: 'scores', type: 'array' }])
  const scores = (v.scores as unknown[]).map(Number)
  if (scores.length !== input.frames.length) return { status: 'unknown', reason: 'checker skipped candidates', scores }
  return scores.every((s) => s >= 8) ? { status: 'pass', reason: `scores ${scores.join(', ')}`, scores } : { status: 'fail', reason: `scores ${scores.join(', ')}: ${String(v.differences ?? '')}`, scores }
})

export const expressionScorer = videoScorer('video-expression', 'Same mouth, eyes and mood as the reference at the same moment', async (input: { ask?: AskFn; tenantId?: string; reference: Img; frame: Img; expected: string }) => {
  const v = await askChecked(askFor(input), [{ text: 'REFERENCE face:' }, { image: input.reference }, { text: 'REMAKE face:' }, { image: input.frame }, { text: `Expected expression: ${input.expected}. Compare the REMAKE to the REFERENCE. Reply ONLY JSON {"same_mouth":true|false,"same_eyes":true|false,"same_mood":true|false,"what":"short"}` }], [{ key: 'same_mouth', type: 'boolean' }, { key: 'same_eyes', type: 'boolean' }, { key: 'same_mood', type: 'boolean' }])
  const ok = v.same_mouth === true && v.same_eyes === true && v.same_mood === true
  return { status: ok ? 'pass' : 'fail', reason: String(v.what ?? '') }
})

export const poseLegsScorer = videoScorer('video-pose-legs', 'Same pose and body axis as the reference; feet on the expected side', async (input: { ask?: AskFn; tenantId?: string; reference: Img; frame: Img; expectedFeet: 'image-left' | 'image-right' | 'center' }) => {
  const v = await askChecked(askFor(input), [{ text: 'REFERENCE:' }, { image: input.reference }, { text: 'REMAKE:' }, { image: input.frame }, { text: 'Overhead photos of a person lying down. Use IMAGE directions (viewer left/right). For the REMAKE: where do the FEET end up relative to the hips, and where do the KNEES point? Is the overall pose (arms, legs, head) the same as the REFERENCE? Is the body axis (straight vs diagonal, centred vs off-centre) the same? Reply ONLY JSON {"feet":"image-left|image-right|center","knees":"image-left|image-right|center","same_pose":true|false,"body_axis_same":true|false,"what":"short"}' }], [{ key: 'feet', type: 'string' }, { key: 'knees', type: 'string' }, { key: 'same_pose', type: 'boolean' }, { key: 'body_axis_same', type: 'boolean' }])
  const ok = v.feet === input.expectedFeet && v.same_pose === true && v.body_axis_same === true
  return { status: ok ? 'pass' : 'fail', reason: `feet ${String(v.feet)}, knees ${String(v.knees)}, pose ${v.same_pose ? 'same' : 'different'}, axis ${v.body_axis_same ? 'same' : 'different'}${v.what ? ` — ${String(v.what)}` : ''}`, feet: v.feet, knees: v.knees }
})

export const emptyHandScorer = videoScorer('video-empty-hand', 'No hand acts on an object that is not there', async (input: { ask?: AskFn; tenantId?: string; frames: Img[] }) => {
  const v = await askChecked(askFor(input), [...imgs('Frame (time order)', input.frames), { text: 'Does any hand grab, touch, adjust or hold something that is NOT actually there (pinching air, adjusting a missing dupatta)? Reply ONLY JSON {"empty_hand_action":true|false,"what":"short"}' }], [{ key: 'empty_hand_action', type: 'boolean' }])
  return v.empty_hand_action === false ? { status: 'pass', reason: 'no empty-hand action' } : { status: 'fail', reason: String(v.what ?? 'hand acts on nothing') }
})
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/scorers && npx tsc --noEmit -p .`
Expected: PASS. If `createScorer(...).run` requires a different input envelope in 1.64 (check `node_modules/@mastra/core/dist/docs/references/reference-evals-create-scorer.md`), adapt `runGate` only — the scorers' `run.input` contract stays as above — and ledger the ruling.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/scorers/video
git commit -m "feat(scorers): video vision checks as Mastra scorers + blocking runGate (unknown never passes)"
```

---

### Task 6: Prompt check scorer

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/scorers/video/promptCheck.ts`, `promptCheck.test.ts`

**Interfaces:**
- Consumes: `gatewayAsk`, `askChecked` (text-only parts), `checkModel()`, `runGate` (Task 5).
- Produces:
  - `precheckPrompt(prompt: string, look: { expression?: string }): string[]` — deterministic issues, no model call.
  - `promptCheckScorer` with `run.input`: `{ ask?; tenantId?; prompt: string; planLine: string; look: { expression?: string; start_pose?: string; end_pose?: string; moves?: unknown[]; leg_side?: string }; startFrameObjects: string[]; keyMoments: string[] }` → analyze `{ status, reason, invented: string[], contradicts: string[], missing: string[], hand_on_absent_object: string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { it, expect, vi } from 'vitest'
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))
import { precheckPrompt, promptCheckScorer } from './promptCheck.js'
import { runGate } from './gate.js'

const look = { expression: 'mouth gently closed, poised, no smile', leg_side: 'image-right' }
it('blocks a smile against a closed-mouth expression without any model call', async () => {
  expect(precheckPrompt('She smiles warmly and laughs', look)).toEqual(expect.arrayContaining([expect.stringMatching(/smile/i)]))
  const ask = vi.fn()
  const r = await runGate(promptCheckScorer, 'prompt', { ask, prompt: 'She smiles at the camera.', planLine: 'look 2 hold', look, startFrameObjects: [], keyMoments: [] }, [])
  expect(r.status).toBe('fail')
  expect(ask).not.toHaveBeenCalled()
})
it('blocks on any judge finding', async () => {
  const ask = vi.fn(async () => ({ invented: [], contradicts: ['legs drift LEFT but plan says image-right'], missing: [], hand_on_absent_object: [] }))
  const r = await runGate(promptCheckScorer, 'prompt', { ask, prompt: 'legs drift to the left', planLine: 'legs right', look, startFrameObjects: ['remote'], keyMoments: [] }, [])
  expect(r).toMatchObject({ status: 'fail', reason: expect.stringMatching(/image-right/) })
})
it('passes a clean prompt', async () => {
  const ask = vi.fn(async () => ({ invented: [], contradicts: [], missing: [], hand_on_absent_object: [] }))
  const r = await runGate(promptCheckScorer, 'prompt', { ask, prompt: 'she holds still, mouth closed', planLine: 'hold', look, startFrameObjects: [], keyMoments: [] }, [])
  expect(r.status).toBe('pass')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/scorers/video/promptCheck.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `promptCheck.ts`**

```ts
import { createScorer } from '@mastra/core/evals'
import { askChecked, gatewayAsk, CheckUnavailableError, type AskFn } from '../../tools/tvcChecks.js'
import { checkModel } from '../../tools/videoBreakdown/models.js'

const NO_SMILE = /mouth (gently )?closed|no smile|lips closed|poised|composed/i
const SMILE_WORDS = /\b(smil\w*|laugh\w*|grin\w*|teeth)\b/i

// Free, no model call: the exact mistake the spike paid for (spec §7.1).
export function precheckPrompt(prompt: string, look: { expression?: string }): string[] {
  const issues: string[] = []
  if (look.expression && NO_SMILE.test(look.expression) && SMILE_WORDS.test(prompt)) {
    issues.push(`prompt asks for "${prompt.match(SMILE_WORDS)![0]}" but the reference expression is "${look.expression}"`)
  }
  return issues
}

type Input = { ask?: AskFn; tenantId?: string; prompt: string; planLine: string; look: Record<string, unknown> & { expression?: string }; startFrameObjects: string[]; keyMoments: string[] }

export const promptCheckScorer = createScorer({ id: 'video-prompt-check', name: 'video-prompt-check', description: 'Blocks a paid generation prompt that invents, contradicts or drops what the reference/plan says' })
  .analyze(async ({ run }) => {
    const input = run.input as Input
    const pre = precheckPrompt(input.prompt, input.look)
    if (pre.length) return { status: 'fail', reason: pre.join('; '), invented: pre, contradicts: [], missing: [], hand_on_absent_object: [] }
    const ask = input.ask ?? gatewayAsk(input.tenantId ?? '', fetch, checkModel())
    try {
      const v = await askChecked(ask, [{ text: `You check a video-generation prompt BEFORE money is spent.
PLAN LINE (what this generation must do): ${input.planLine}
REFERENCE LOOK (expression, poses, moves, leg side): ${JSON.stringify(input.look)}
KEY MOMENTS that must happen: ${JSON.stringify(input.keyMoments)}
OBJECTS visible in the start frame: ${JSON.stringify(input.startFrameObjects)}
PROMPT: ${input.prompt}
List problems in the PROMPT only:
- invented: things the prompt adds that the reference/plan does not show (an expression, an effect, an action)
- contradicts: things that conflict with the plan or look (directions are image-left/right)
- missing: key moments or plan items the prompt leaves out
- hand_on_absent_object: hand actions on objects NOT in the start-frame list
Reply ONLY JSON {"invented":[],"contradicts":[],"missing":[],"hand_on_absent_object":[]}` }], [{ key: 'invented', type: 'array' }, { key: 'contradicts', type: 'array' }, { key: 'missing', type: 'array' }, { key: 'hand_on_absent_object', type: 'array' }])
      const all = ['invented', 'contradicts', 'missing', 'hand_on_absent_object'].flatMap((k) => (v[k] as unknown[]).map((x) => `${k}: ${String(x)}`))
      return { status: all.length ? 'fail' : 'pass', reason: all.join('; ') || 'prompt matches plan and reference', ...v }
    } catch (err) {
      if (err instanceof CheckUnavailableError) return { status: 'unknown', reason: err.message, invented: [], contradicts: [], missing: [], hand_on_absent_object: [] }
      throw err
    }
  })
  .generateScore(({ results }) => ((results.analyzeStepResult as { status: string }).status === 'pass' ? 1 : 0))
  .generateReason(({ results }) => (results.analyzeStepResult as { reason: string }).reason)
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/scorers && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/scorers/video/promptCheck.ts apps/agent-orchestrator/src/mastra/scorers/video/promptCheck.test.ts
git commit -m "feat(scorers): prompt check before every paid call (free expression pre-check + judge)"
```

---

### Task 7: `compare_to_reference` (function + agent tool) and scorer registration

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/compareToReference.ts`, `compareToReference.test.ts`
- Modify: `.../videoBreakdown/index.ts`, `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (both tool maps), `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (+ `src/mastra/__tests__/serverTools.test.ts` exhaustive list), `apps/agent-orchestrator/src/mastra/index.ts` (register scorers), `src/mastra/scorers/index.ts`

**Interfaces:**
- Consumes: `breakDownVideo` (phase 1), `runGate`, `poseLegsScorer`, `expressionScorer`, `samePersonScorer`, `aiService('/media/brightness-jumps')`, `sampleFrames` (`tvcChecks.ts`).
- Produces:
  - `pairTimes(reference: Breakdown): number[]` — measured moment times + the middle of each look between measured boundaries; never unmeasured moment times.
  - `compareToReference(refInput: {url?: string; fileId?: string}, remakeFileId: string, ctx, tenantId?, deps?): Promise<{ checks: CheckResult[]; brightnessJumps: { reference: number; remake: number }; summary: string }>`
  - tool `compare_to_reference` `{ referenceUrl?, referenceFileId?, remakeFileId }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { it, expect, vi } from 'vitest'
const bd = vi.fn(); const ai = vi.fn(); const gate = vi.fn()
vi.mock('./breakDownVideo.js', () => ({ breakDownVideo: (...a: unknown[]) => bd(...a) }))
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
vi.mock('../../scorers/video/gate.js', () => ({ runGate: (...a: unknown[]) => gate(...a) }))
vi.mock('../tvcChecks.js', async (orig) => ({ ...(await orig<object>()), sampleFrames: vi.fn(async (_p: string, t: number[]) => t.map(() => ({ data: 'AA', mime: 'image/jpeg' }))) }))
vi.mock('./fetchVideo.js', () => ({ fetchVideo: vi.fn(async (i: { url?: string; fileId?: string }) => ({ filePath: i.fileId ? '/m/remake.mp4' : '/m/ref.mp4', durationS: 14.9, tooLong: false })) }))
import { pairTimes, compareToReference } from './compareToReference.js'

const ref = { video: { durationS: 14.9 }, hidden_cuts: [{ at_s: 5.4 }, { at_s: 9.2 }], cuts: { cuts: [] }, overview: { moments: [{ t_s: 1.25, measured: true }, { t_s: 3, measured: false }], looks: [{ leg_side: 'image-right', expression: 'poised' }, { leg_side: 'image-left' }, { leg_side: 'image-right' }] } } as any

it('pairs at measured moments and look middles, never at unmeasured times', () => {
  expect(pairTimes(ref)).toEqual([1.25, 2.7, 7.3, 12.05])
})

it('runs pose/legs, expression and same-person gates and compares brightness jumps', async () => {
  bd.mockResolvedValue(ref)
  ai.mockResolvedValueOnce({ count: 0, jumps: [] }).mockResolvedValueOnce({ count: 6, jumps: [] })
  gate.mockResolvedValue({ name: 'x', status: 'pass', reason: '', evidenceTimes: [] })
  const r = await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', { idToken: 't', scopeId: 's', conversationId: 'c' })
  expect(r.brightnessJumps).toEqual({ reference: 0, remake: 6 })
  expect(r.checks.some((c) => c.name === 'brightness-jumps' && c.status === 'fail')).toBe(true)
  expect(gate.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining(['pose-legs@2.7', 'expression@2.7', 'same-person']))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/videoBreakdown/compareToReference.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `compareToReference.ts`**

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { breakDownVideo, type Breakdown } from './breakDownVideo.js'
import { fetchVideo } from './fetchVideo.js'
import { aiService } from './aiServiceClient.js'
import { sampleFrames } from '../tvcChecks.js'
import { runGate, type CheckResult } from '../../scorers/video/gate.js'
import { poseLegsScorer, expressionScorer, samePersonScorer } from '../../scorers/video/visionScorers.js'

const r2 = (n: number) => Math.round(n * 100) / 100

// Sample only at MEASURED times (spec §8: the first verifier sampled at Gemini's
// rough times and flagged correct timing as wrong).
export function pairTimes(reference: Breakdown): number[] {
  const bounds = [0, ...reference.hidden_cuts.map((h) => h.at_s), ...(reference.cuts?.cuts ?? []), reference.video.durationS].sort((a, b) => a - b)
  const mids = bounds.slice(0, -1).map((b, i) => r2((b + bounds[i + 1]) / 2))
  const moments = reference.overview.moments.filter((m) => m.measured).map((m) => m.t_s)
  return [...new Set([...moments, ...mids])].sort((a, b) => a - b)
}

type Ctx = { idToken: string; scopeId: string; conversationId: string }

export async function compareToReference(refInput: { url?: string; fileId?: string }, remakeFileId: string, ctx: Ctx, tenantId?: string) {
  const reference = await breakDownVideo(refInput, ctx, tenantId)
  const refVideo = await fetchVideo(refInput, ctx)
  const remake = await fetchVideo({ fileId: remakeFileId }, ctx)
  const times = pairTimes(reference).filter((t) => t < remake.durationS)
  const bounds = [0, ...reference.hidden_cuts.map((h) => h.at_s), ...(reference.cuts?.cuts ?? []), reference.video.durationS].sort((a, b) => a - b)
  const lookAt = (t: number) => Math.max(0, bounds.findIndex((b, i) => t >= b && t < (bounds[i + 1] ?? Infinity)))
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const refFrames = await sampleFrames(refVideo.filePath, times, dir)
    const newFrames = await sampleFrames(remake.filePath, times, dir)
    const checks: CheckResult[] = []
    for (const [i, t] of times.entries()) {
      const look = reference.overview.looks[lookAt(t)] ?? {}
      const feet = (look.leg_side === 'image-left' || look.leg_side === 'image-right') ? look.leg_side : 'center'
      checks.push(await runGate(poseLegsScorer, `pose-legs@${t}`, { tenantId, reference: refFrames[i], frame: newFrames[i], expectedFeet: feet }, [t]))
      checks.push(await runGate(expressionScorer, `expression@${t}`, { tenantId, reference: refFrames[i], frame: newFrames[i], expected: look.expression ?? 'same as reference' }, [t]))
    }
    checks.push(await runGate(samePersonScorer, 'same-person', { tenantId, reference: newFrames[0], frames: newFrames.slice(1) }, times))
    const [rj, mj] = await Promise.all([
      aiService<{ count: number }>('/media/brightness-jumps', { path: refVideo.filePath }),
      aiService<{ count: number }>('/media/brightness-jumps', { path: remake.filePath }),
    ])
    checks.push({ name: 'brightness-jumps', status: mj.count > rj.count ? 'fail' : 'pass', reason: `reference ${rj.count}, remake ${mj.count}`, evidenceTimes: [] })
    const bad = checks.filter((c) => c.status !== 'pass')
    return { checks, brightnessJumps: { reference: rj.count, remake: mj.count }, summary: bad.length ? `${bad.length} difference(s): ${bad.map((c) => `${c.name} ${c.status} (${c.reason})`).join('; ')}` : 'matches the reference on every check' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const compareToReferenceTool = createTool({
  id: 'compare_to_reference',
  description: 'Compare a finished remake to its reference video at measured moments: pose and leg side, expression, same person throughout, and sudden brightness jumps. Use when the user asks how close the remake is.',
  inputSchema: z.object({ referenceUrl: z.string().url().optional(), referenceFileId: z.string().optional(), remakeFileId: z.string() }),
  outputSchema: z.object({ success: z.boolean(), result: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const rc = execContext?.requestContext
    const idToken = rc?.get('idToken') as string | undefined
    const tenantId = rc?.get('tenantId') as string | undefined
    const sessionId = rc?.get('sessionId') as string | undefined
    const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    try {
      return { success: true, result: await compareToReference({ url: input.referenceUrl, fileId: input.referenceFileId }, input.remakeFileId, { idToken, scopeId: tenantId ?? sessionId, conversationId }, tenantId) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
```

Registration:
- `index.ts` (videoBreakdown): `export { compareToReferenceTool } from './compareToReference.js'`.
- Director (both maps) and Olmo: `compare_to_reference: compareToReferenceTool`; add `'compare_to_reference'` to the exhaustive list in `serverTools.test.ts` (sorted).
- `src/mastra/scorers/index.ts`: export the six video scorers; `src/mastra/index.ts` `scorers:` add `videoPropCount: propCountScorer, videoSamePerson: samePersonScorer, videoExpression: expressionScorer, videoPoseLegs: poseLegsScorer, videoEmptyHand: emptyHandScorer, videoPromptCheck: promptCheckScorer` (Studio visibility).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run && npx tsc --noEmit -p .`
Expected: whole suite PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra
git commit -m "feat(video-breakdown): compare_to_reference at measured times; video scorers registered for Studio"
```

---

### Task 8: Golden set with Mastra `runEvals`

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/workflows/videoBreakdownWorkflow.ts`, `src/mastra/scorers/video/goldenScorers.ts`, `goldenScorers.test.ts`, `apps/agent-orchestrator/scripts/video-golden-set.ts`, `apps/agent-orchestrator/scripts/video-golden-set.fixtures.json`
- Modify: `.../videoBreakdown/breakDownVideo.ts` (export `breakDownLocalFile`), `src/mastra/index.ts` (register workflow)

**Interfaces:**
- Produces:
  - `breakDownLocalFile(filePath: string, tenantId?: string): Promise<Breakdown>` — same pipeline as `breakDownVideo` without fetch/upload (probes the local file, `youtubeUrl: null`).
  - workflow id `video-breakdown-local`: input `{ filePath: string }`, output `Breakdown`.
  - golden scorers (function-based, deterministic) with `run.output: Breakdown`, `run.groundTruth`:
    - `goldenCutsScorer`: `|cuts| within ±15% of truth.cutCount` → 1/0
    - `goldenHiddenCutsScorer`: same count and each within ±0.4s of `truth.hiddenCuts`
    - `goldenMomentsScorer`: each `truth.moments[{what, t_s}]` matched by a MEASURED moment within ±0.5s → fraction matched
    - `goldenLegsScorer`: fraction of looks whose `leg_side` equals `truth.legSides[i]`
  - script `pnpm tsx scripts/video-golden-set.ts` → prints `verdict` and exits 1 unless `passed`.

- [ ] **Step 1: Write the failing tests** (`goldenScorers.test.ts`)

```ts
import { it, expect } from 'vitest'
import { goldenCutsScorer, goldenHiddenCutsScorer, goldenMomentsScorer, goldenLegsScorer } from './goldenScorers.js'
const out = { cuts: { cuts: Array.from({ length: 32 }, (_, i) => i) }, hidden_cuts: [{ at_s: 5.43 }, { at_s: 9.23 }, { at_s: 12.78 }],
  overview: { moments: [{ t_s: 1.3, what: 'points remote up', measured: true }, { t_s: 3.2, what: 'legs slide right', measured: false }], looks: [{ leg_side: 'image-right' }, { leg_side: 'image-left' }, { leg_side: 'center' }, { leg_side: 'image-left' }] } }
it('cuts within 15%', async () => { expect((await goldenCutsScorer.run({ input: {}, output: out, groundTruth: { cutCount: 30 } })).score).toBe(1) })
it('hidden cuts within 0.4s', async () => { expect((await goldenHiddenCutsScorer.run({ input: {}, output: out, groundTruth: { hiddenCuts: [5.3, 9.1, 12.7] } })).score).toBe(1) })
it('moments count only when MEASURED and within 0.5s', async () => {
  expect((await goldenMomentsScorer.run({ input: {}, output: out, groundTruth: { moments: [{ t_s: 1.25 }, { t_s: 3.25 }] } })).score).toBe(0.5)
})
it('leg sides as a fraction', async () => {
  expect((await goldenLegsScorer.run({ input: {}, output: out, groundTruth: { legSides: ['image-right', 'image-left', 'image-right', 'image-left'] } })).score).toBe(0.75)
})
```

Also a script-guard test in the same file:
```ts
import { missingFixtures } from '../../../../scripts/video-golden-set.js'
it('reports missing fixture videos instead of passing silently', () => {
  expect(missingFixtures([{ input: { filePath: '/definitely/missing.mp4' } }])).toEqual(['/definitely/missing.mp4'])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/scorers/video/goldenScorers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`goldenScorers.ts`:
```ts
import { createScorer } from '@mastra/core/evals'

type Out = { cuts?: { cuts: number[] } | null; hidden_cuts: Array<{ at_s: number }>; overview: { moments: Array<{ t_s: number; measured?: boolean }>; looks: Array<{ leg_side?: string }> } }
const gt = (run: { groundTruth?: unknown }) => (run.groundTruth ?? {}) as Record<string, any>

export const goldenCutsScorer = createScorer({ id: 'golden-cuts', name: 'golden-cuts', description: 'Hard-cut count within 15% of the measured truth' })
  .generateScore(({ run }) => { const n = (run.output as Out).cuts?.cuts.length ?? 0; const t = gt(run).cutCount as number; return Math.abs(n - t) <= Math.max(1, 0.15 * t) ? 1 : 0 })
export const goldenHiddenCutsScorer = createScorer({ id: 'golden-hidden-cuts', name: 'golden-hidden-cuts', description: 'Hidden cuts: same count, each within 0.4s' })
  .generateScore(({ run }) => { const got = (run.output as Out).hidden_cuts.map((h) => h.at_s); const want = gt(run).hiddenCuts as number[]; return got.length === want.length && want.every((w, i) => Math.abs(got[i] - w) <= 0.4) ? 1 : 0 })
export const goldenMomentsScorer = createScorer({ id: 'golden-moments', name: 'golden-moments', description: 'Fraction of truth moments matched by a MEASURED moment within 0.5s' })
  .generateScore(({ run }) => { const ms = (run.output as Out).overview.moments.filter((m) => m.measured); const want = gt(run).moments as Array<{ t_s: number }>; return want.length ? want.filter((w) => ms.some((m) => Math.abs(m.t_s - w.t_s) <= 0.5)).length / want.length : 1 })
export const goldenLegsScorer = createScorer({ id: 'golden-legs', name: 'golden-legs', description: 'Fraction of looks with the right leg side' })
  .generateScore(({ run }) => { const looks = (run.output as Out).overview.looks; const want = gt(run).legSides as string[]; return want.length ? want.filter((w, i) => looks[i]?.leg_side === w).length / want.length : 1 })
```

`breakDownVideo.ts` — extract the body after `fetchVideo` into `async function breakDownFetched(video: FetchedVideo, tenantId?: string): Promise<Breakdown>`; `breakDownVideo` = fetch + `breakDownFetched`; add:
```ts
export async function breakDownLocalFile(filePath: string, tenantId?: string): Promise<Breakdown> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', filePath], { timeout: 30_000 })
  const p = JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string }> }
  const v = p.streams.find((s) => s.codec_type === 'video')
  const [n, d] = (v?.r_frame_rate ?? '30/1').split('/').map(Number)
  return breakDownFetched({ fileId: '', filePath, durationS: Math.round(parseFloat(p.format.duration) * 100) / 100, width: v?.width ?? 0, height: v?.height ?? 0, fps: d ? n / d : 30, hasAudio: p.streams.some((s) => s.codec_type === 'audio'), caption: null, song: null, youtubeUrl: null, platform: 'local', tooLong: false }, tenantId)
}
```
(add `execFile` = `promisify(execFileCb)` imports.)

`videoBreakdownWorkflow.ts`:
```ts
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { breakDownLocalFile } from '../tools/videoBreakdown/breakDownVideo.js'

const step = createStep({ id: 'break-down-local', inputSchema: z.object({ filePath: z.string() }), outputSchema: z.any(), execute: async ({ inputData }) => breakDownLocalFile(inputData.filePath) })
// Golden-set target (spec §8a): runEvals / Studio experiments run the real breakdown on local fixture files.
export const videoBreakdownWorkflow = createWorkflow({ id: 'video-breakdown-local', inputSchema: z.object({ filePath: z.string() }), outputSchema: z.any() }).then(step).commit()
```
Register in `src/mastra/index.ts` `workflows: { ..., 'video-breakdown-local': videoBreakdownWorkflow }`.

`scripts/video-golden-set.fixtures.json` (expected values measured in the spike; paths via env):
```json
[
  { "input": { "filePath": "${GOLDEN_DIR}/fan_reel.mp4" }, "groundTruth": { "cutCount": 0, "hiddenCuts": [5.4, 9.2, 12.7], "moments": [{ "what": "points remote up", "t_s": 1.25 }, { "what": "legs slide right", "t_s": 3.25 }], "legSides": ["image-right", "image-left", "image-right", "image-left"] } },
  { "input": { "filePath": "${GOLDEN_DIR}/sony.mp4" }, "groundTruth": { "cutCount": 32, "hiddenCuts": [], "moments": [], "legSides": [] } }
]
```

`scripts/video-golden-set.ts`:
```ts
import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runEvals } from '@mastra/core/evals'
import { videoBreakdownWorkflow } from '../src/mastra/workflows/videoBreakdownWorkflow.js'
import { goldenCutsScorer, goldenHiddenCutsScorer, goldenMomentsScorer, goldenLegsScorer } from '../src/mastra/scorers/video/goldenScorers.js'

type Item = { input: { filePath: string }; groundTruth?: unknown }
export function missingFixtures(items: Item[]): string[] {
  return items.map((i) => i.input.filePath).filter((p) => !existsSync(p))
}

async function main() {
  const dir = process.env.GOLDEN_DIR
  if (!dir) { console.error('Set GOLDEN_DIR to the folder holding fan_reel.mp4 and sony.mp4'); process.exit(1) }
  const raw = readFileSync(join(import.meta.dirname, 'video-golden-set.fixtures.json'), 'utf8').replaceAll('${GOLDEN_DIR}', dir)
  const data = JSON.parse(raw) as Item[]
  const missing = missingFixtures(data)
  if (missing.length) { console.error(`Missing fixture videos: ${missing.join(', ')}`); process.exit(1) }
  const result = await runEvals({
    data,
    target: videoBreakdownWorkflow,
    gates: [goldenHiddenCutsScorer, goldenCutsScorer],
    scorers: [{ scorer: goldenMomentsScorer, threshold: 0.75 }, { scorer: goldenLegsScorer, threshold: 0.75 }],
  })
  console.log(JSON.stringify({ verdict: result.verdict, scores: result.scores }, null, 2))
  process.exit(result.verdict === 'passed' ? 0 : 1)
}
if (import.meta.url === `file://${process.argv[1]}`) void main()
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/scorers/video && npx tsc --noEmit -p .`
Expected: PASS. Then the live run (needs local gateway + ai-service, ~Rs 5): `GOLDEN_DIR=/tmp/claude-501/real INFERENCE_GATEWAY_URL=http://localhost:4011 AI_SERVICE_URL=http://localhost:3004 pnpm tsx scripts/video-golden-set.ts` → expect `"verdict": "passed"`; if `scored`/`failed`, record which scorer and why in the ledger — do NOT loosen thresholds to make it pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/workflows/videoBreakdownWorkflow.ts apps/agent-orchestrator/src/mastra/scorers/video/goldenScorers.ts apps/agent-orchestrator/src/mastra/scorers/video/goldenScorers.test.ts apps/agent-orchestrator/scripts/video-golden-set.ts apps/agent-orchestrator/scripts/video-golden-set.fixtures.json apps/agent-orchestrator/src/mastra/tools/videoBreakdown/breakDownVideo.ts apps/agent-orchestrator/src/mastra/index.ts
git commit -m "feat(evals): video golden set on Mastra runEvals (gates: hidden cuts, cuts; thresholds: moments, legs)"
```

---

### Task 9: Deploy notes

**Files:**
- Modify: `docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md` (append a Phase 2 section; commit with `git add -f`)

- [ ] **Step 1: Append**

```md

# Phase 2 additions

1. Orchestrator env (optional): VIDEO_WATCH_MODEL, VIDEO_CHECK_MODEL (default gemini-3.8-flash; set gemini-3.6-flash to switch back without code).
2. ai-service: restart PM2 `ai-service` (new /media/motion-peaks, /media/brightness-jumps, /media/coverage).
3. Studio: the six video scorers and the `video-breakdown-local` workflow appear after the orchestrator restart.
4. Golden set before any prompt/model change: GOLDEN_DIR=<folder with fan_reel.mp4, sony.mp4> pnpm tsx scripts/video-golden-set.ts → must print "passed".
```

- [ ] **Step 2: Commit**

```bash
git add -f docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md
git commit -m "docs: phase 2 deploy notes"
```
